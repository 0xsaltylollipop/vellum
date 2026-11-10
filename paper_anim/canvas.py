"""Hermes's pen in the paper: a few small tools that draw on a live canvas under a paragraph.

The tools run in Hermes's agent turn; the canvas lives in the paper in Hermes's browser pane. A tool pushes its
request to the desktop half (broadcast_plugin_event -> host.onEvent), the desktop half runs it in the sandboxed
canvas and posts the result back to our backend (dashboard/plugin_api.py), which drops it in a small file here;
the tool picks it up and returns it to Hermes. Files, not memory, because the backend and the agent turn may run
in different processes.
"""
import hashlib
import json
import logging
import re
import threading
import time
import uuid
from pathlib import Path

from .config import data_dir

log = logging.getLogger(__name__)
PLUGIN_ID = "vellum"
# Papers the plugin works with: arXiv's own HTML, and ar5iv (arXiv's HTML for older papers); both are LaTeXML pages.
PAPER_URL = re.compile(r"https://(?:arxiv\.org|ar5iv\.labs\.arxiv\.org|ar5iv\.org)/html/[^)\s#`]{1,160}")
CANVAS_ID = re.compile(r"pa-[a-z0-9]{1,30}")  # a figure card's id, as desktop/plugin.js makes them
ERROR_MAX = 600  # characters of a figure's error message passed on to the model
LOOK_MAX = 20000  # characters of vellum_look's layout report


def relay_dir() -> Path:
    d = data_dir() / "canvas"
    (d / "results").mkdir(parents=True, exist_ok=True)
    (d / "papers").mkdir(parents=True, exist_ok=True)
    return d


def _write(p: Path, text: str) -> None:
    """Write a file in one piece: a reader (another process) sees the old file or the new one, never half of it. Each
    write has its own temporary file, so two writes at once don't collide."""
    tmp = p.with_name(f".{p.name}.{uuid.uuid4().hex[:8]}.part")
    try:
        tmp.write_text(text)
        tmp.replace(p)
    except BaseException:  # a failed write leaves nothing behind
        tmp.unlink(missing_ok=True)
        raise


def save_result(req: str, result: dict) -> None:
    if not re.fullmatch(r"[0-9a-f]{16}", req):  # the ids _request hands out
        return
    _write(relay_dir() / "results" / f"{req}.json", json.dumps(result))


def save_state(name: str, data: dict) -> None:
    """Small bits of desktop state the hooks read: whether the plugin is on ("state"), the current highlight
    ("selection"). The hooks run in Hermes's agent process, the routes in the plugin host: a file bridges them."""
    if name not in ("state", "selection"):
        return
    _write(relay_dir() / f"{name}.json", json.dumps({**data, "t": time.time()}))


CARDS_KEPT = 50  # the most recent figure cards the user opened (older ones can no longer start a paper turn)
_cards_lock = threading.Lock()


def save_card(card_id: str, url: str, sessions: list) -> bool:
    """The user clicked ✨ Visualize or 💬 Ask on a passage: Desktop registers the card it opened. A paper turn is only
    ever started for a card registered here, so a message that merely looks like a Vellum draft is an ordinary one.
    `sessions` are the ids of the Desktop chat it was clicked in, when it has any yet."""
    url = url.split("#")[0]
    if not CANVAS_ID.fullmatch(card_id) or not PAPER_URL.fullmatch(url):
        return False
    with _cards_lock:
        cards = _cards()
        cards[card_id] = {"url": url, "sessions": [str(s)[:200] for s in sessions if isinstance(s, str) and s][:4],
                          "t": time.time()}
        newest = sorted(cards.items(), key=lambda kv: kv[1].get("t", 0))[-CARDS_KEPT:]
        _write(relay_dir() / "cards.json", json.dumps(dict(newest)))
    return True


def _cards() -> dict:
    try:
        cards = json.loads((relay_dir() / "cards.json").read_text())
        return cards if isinstance(cards, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def card(card_id: str) -> dict:
    """A card the user opened in Desktop ({} when it isn't one)."""
    c = _cards().get(card_id)
    return c if isinstance(c, dict) else {}


OUR_MARKS = re.compile(r"\[(?=\s*vellum)|={3,}", re.I)  # our own markers' shapes: "[Vellum, for you only: …]", "=== … ==="


def defuse(page_text: str) -> str:
    """Page text loses the shape of our own notes to the model ("[Vellum" -> "(Vellum", "===" -> "---"). The length
    stays the same, so offsets into the paper text still hold."""
    return OUR_MARKS.sub(lambda m: "(" if m.group(0) == "[" else "-" * len(m.group(0)), page_text)


def paper_key(url: str) -> str:
    """The file name a paper's text is stored under."""
    return hashlib.sha1(url.split("#")[0].encode()).hexdigest()[:16]


def save_paper(url: str, title: str, text: str) -> None:
    key = paper_key(url)
    _write(relay_dir() / "papers" / f"{key}.txt", f"# {title}\n{url}\n\n{text}")
    _write(relay_dir() / "papers" / "latest.json", json.dumps({"url": url, "title": title, "key": key}))


STATE_FRESH_S = 75  # Desktop re-confirms "on" about every 20 s; older than this (Desktop closed or crashed) is off


def is_on() -> bool:
    """Vellum is switched on in a running Hermes Desktop's paper (the status-bar chip)."""
    try:
        st = json.loads((relay_dir() / "state.json").read_text())
        return bool(st.get("armed")) and time.time() - float(st.get("t", 0)) < STATE_FRESH_S
    except Exception:
        return False


_pruned = 0.0


def prune() -> None:
    """Keep the plugin's files small: voiced sentences for a day, stray tool answers for an hour, the 20 most recently
    opened papers. Runs on paper turns and canvas calls, at most every ten minutes."""
    global _pruned
    now = time.time()
    if now - _pruned < 600:
        return
    _pruned = now
    for sub, age in (("voice", 86400), ("results", 3600)):
        d = relay_dir() / sub
        for f in d.iterdir() if d.is_dir() else []:
            try:
                if f.is_file() and now - f.stat().st_mtime > age:
                    f.unlink()
            except OSError as e:
                log.debug("vellum: could not prune %s: %s", f.name, e)
    papers = sorted((relay_dir() / "papers").glob("*.txt"), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in papers[20:]:
        f.unlink(missing_ok=True)


def _request(event: str, payload: dict, timeout: float) -> dict:
    """Push a request to the paper and wait for its answer."""
    prune()
    if not is_on():  # fail at once (cron, messaging, a closed Desktop) instead of waiting for a paper that isn't there
        return {"ok": False, "error": "Vellum is off: there is no paper canvas to draw on. Answer in text."}
    from hermes_cli.plugin_events import broadcast_plugin_event
    req = uuid.uuid4().hex[:16]
    path = relay_dir() / "results" / f"{req}.json"
    broadcast_plugin_event(PLUGIN_ID, event, {**payload, "req": req})
    end = time.time() + timeout
    while time.time() < end:
        if path.exists():
            try:
                out = json.loads(path.read_text())
                path.unlink(missing_ok=True)
                return out
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(0.05)
    return {"ok": False, "error": "The paper didn't answer. Is it open in Hermes's browser with Vellum on?"}


def _canvas(args: dict) -> str:
    """The canvas id a tool was given, or "" when it isn't one of ours."""
    canvas = str(args.get("canvas") or "").strip()
    return canvas if CANVAS_ID.fullmatch(canvas) else ""


def _bounded(out: dict) -> dict:
    """A figure's error text is written by the figure's own code: pass on a bounded, one-line version."""
    if isinstance(out, dict) and out.get("error"):
        out["error"] = " ".join(str(out["error"]).split())[:ERROR_MAX]
    return out


def vellum_draw(args: dict, **kwargs) -> str:
    canvas, code = _canvas(args), str(args.get("code") or "")
    if not canvas or not code.strip():
        return json.dumps({"ok": False, "error": "Need code and the canvas id from the user's message (like pa-3f2c1)."})
    try:
        from . import turns
        after = turns.piece_after(str(kwargs.get("session_id") or kwargs.get("task_id") or ""))
        out = _bounded(_request("canvas.draw", {"canvas": canvas, "code": code[:60000], "after": after}, 30))
    except Exception as e:  # never raise into the agent loop
        log.debug("vellum: vellum_draw failed", exc_info=True)
        out = {"ok": False, "error": f"draw failed: {e}"[:ERROR_MAX]}
    # The reader is listening while you work: the next words should be spoken before the next step is written.
    if not out.get("ok"):
        # A mistake in the figure's code: fix it. Anything else (no paper open, card closed): don't retry.
        err = str(out.get("error") or "")
        if out.get("kind") != "code":
            out["next"] = "The figure isn't available right now: answer in text."
        elif "still running" in err:
            out["next"] = "It's still drawing, so don't redraw it; just carry on (and don't await long animations)."
        else:
            out["next"] = ("Nothing from that step was kept: redo it in one go with the fix, quietly, with a very short "
                           "`say` (they already heard this one).")
    elif out.get("overlaps") or out.get("outside"):
        out["next"] = ("Drawn, but some labels overlap or are cut off (listed above): fix them quietly in your next "
                       "step, which carries its own `say` as always.")
    else:
        out["next"] = ("Drawn. Next step: what the next piece means goes in its `say`. If the picture is complete, "
                       "end warmly in a sentence or two of text, then reply only: ✓")
    return json.dumps(out)


def vellum_look(args: dict, **kwargs):
    canvas = _canvas(args)
    if not canvas:
        return json.dumps({"ok": False, "error": "Need the canvas id from the user's message (like pa-3f2c1)."})
    try:
        out = _bounded(_request("canvas.look", {"canvas": canvas}, 20))
    except Exception as e:
        return json.dumps({"ok": False, "error": f"look failed: {e}"})
    png = out.pop("png", None)
    text = json.dumps(out)
    if len(text) > LOOK_MAX:  # the report is made inside the figure, by code the model wrote
        text = json.dumps({"ok": bool(out.get("ok")), "note": "The layout report was too long to pass on; go by the picture."})
    if not png or not str(png).startswith("data:image/png;base64,"):
        return text
    # An image tool result: Hermes sees the canvas as pixels (Claude gets a native image block).
    return {"_multimodal": True, "text_summary": text,
            "content": [{"type": "text", "text": text + "\n\nThe canvas as the reader sees it is attached."},
                        {"type": "image_url", "image_url": {"url": png}}]}


def vellum_clear(args: dict, **kwargs) -> str:
    canvas = _canvas(args)
    if not canvas:
        return json.dumps({"ok": False, "error": "Need the canvas id from the user's message (like pa-3f2c1)."})
    try:
        return json.dumps(_bounded(_request("canvas.clear", {"canvas": canvas}, 10)))
    except Exception as e:
        return json.dumps({"ok": False, "error": f"clear failed: {e}"})


def vellum_read(args: dict, **kwargs) -> str:
    papers = relay_dir() / "papers"
    try:
        latest = json.loads((papers / "latest.json").read_text())
        url = str(args.get("url") or "").split("#")[0].strip()
        if url:  # a specific paper (the one named in the user's message); else the one open most recently
            latest = {"url": url, "key": paper_key(url), "title": ""}
        text = (papers / f"{latest['key']}.txt").read_text()
        latest["title"] = latest["title"] or text.split("\n", 1)[0].lstrip("# ")
    except Exception as e:
        log.debug("vellum: vellum_read found no paper: %s", e)
        return json.dumps({"ok": False, "error": "No paper open. Open an arXiv paper's HTML version and switch Vellum on."})
    # Chunks stay well under Hermes's 100k-character tool-result spillover, so the paper lands IN the conversation
    # (not in a spill file), cut at a paragraph boundary.
    try:
        start = max(0, int(args.get("offset") or 0))
    except (TypeError, ValueError):
        return json.dumps({"ok": False, "error": "offset must be a whole number."})
    chunk = text[start:start + CHUNK]
    if start + CHUNK < len(text) and "\n\n" in chunk[CHUNK // 2:]:
        chunk = chunk[:chunk.rindex("\n\n") + 2]
    return json.dumps({"ok": True, "url": latest["url"], "title": latest["title"], "offset": start,
                       "next_offset": start + len(chunk), "total_chars": len(text),
                       "more": start + len(chunk) < len(text), "text": defuse(chunk)})


CHUNK = 60000
CANVAS = "Canvas id, as given in the user's message (e.g. 'pa-3f2c1')."
SCHEMAS = {
    "vellum_draw": {
        "name": "vellum_draw",
        "description": (
            "Draw one step on a live canvas inside the paper the user is reading (960x540 SVG stage, dark), and say "
            "what it means as it appears: `say` is spoken aloud and the piece shows up as you start saying it. "
            "The code is JavaScript run in a sandbox; top-level names persist across calls like notebook cells, so "
            "later steps build on earlier ones. Globals: stage, d3 (v7; its transitions for motion), math(parent, latex, x, y, opts). "
            "Returns ok (with any overlapping or cut-off labels to fix) or the error to fix."),
        "parameters": {"type": "object", "properties": {
            "canvas": {"type": "string", "description": CANVAS},
            "say": {"type": "string", "description": (
                "What you say out loud as this piece appears, in a sentence or two: what it means, the way you'd "
                "tell a friend (not a description of the drawing). At the step that makes it click, why it matters.")},
            "code": {"type": "string", "description": "This step's piece of the figure: a few lines to about 25."}},
            "required": ["canvas", "say", "code"]},
    },
    "vellum_look": {
        "name": "vellum_look",
        "description": ("See the canvas as the reader sees it: a picture plus a layout report (labels outside "
                        "the canvas, overlapping labels, the readout text). Each drawing step already reports overlaps; "
                        "use this only when you're unsure how the figure looks."),
        "parameters": {"type": "object", "properties": {"canvas": {"type": "string", "description": CANVAS}},
                       "required": ["canvas"]},
    },
    "vellum_clear": {
        "name": "vellum_clear",
        "description": "Erase the canvas and forget its variables, to start the figure over.",
        "parameters": {"type": "object", "properties": {"canvas": {"type": "string", "description": CANVAS}},
                       "required": ["canvas"]},
    },
    "vellum_read": {
        "name": "vellum_read",
        "description": ("Read the full text of the paper open in Hermes's browser (the one the user is "
                        "highlighting in), formulas as LaTeX, tables one cell per line. Read it once per paper: it comes "
                        "in chunks, so while `more` is true call again with offset = offset + len(text). If you already "
                        "read it earlier in this chat, use that instead of reading it again."),
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "The paper's URL, as given in the user's message (default: the paper open most recently)."},
            "offset": {"type": "integer", "description": "Character offset for the next chunk (default 0)."}}},
    },
}
HANDLERS = {"vellum_draw": vellum_draw, "vellum_look": vellum_look, "vellum_clear": vellum_clear, "vellum_read": vellum_read}
