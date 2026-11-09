"""Vellum backend, mounted at /api/plugins/vellum/. The desktop half (the paper) talks to it;
the agent half (Hermes's canvas tools and hooks) reads what it stores.

GET  /runtime              the sandboxed figure runtime page (HTML) the card loads into its iframe
POST /canvas/result        the paper's answer to a canvas tool request (draw / look / clear), relayed to the tool
POST /paper                the open paper's full text, for paper_read and the hidden context
POST /state                whether Vellum is on, and which card is LIVE (read by the hooks)
POST /selection            the passage behind a 💬 Ask                         (read by the hooks)
GET  /voice/{file}         one voiced sentence of Hermes's (data URL) for the card to play
"""
import asyncio
import importlib
import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

ROOT = Path(__file__).resolve().parents[1]


def _package(alias: str, folder: Path):
    """Hermes loads this file on its own; load the plugin's shared code under a private name (no sys.path change)."""
    if alias not in sys.modules:
        spec = importlib.util.spec_from_file_location(alias, folder / "__init__.py", submodule_search_locations=[str(folder)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[alias] = mod
        spec.loader.exec_module(mod)
    return sys.modules[alias]


_package("_vellum_core", ROOT / "paper_anim")
_package("_vellum_figure", ROOT / "figure_runtime")
canvas = importlib.import_module("_vellum_core.canvas")
turns = importlib.import_module("_vellum_core.turns")
runtime_html = importlib.import_module("_vellum_figure.build").runtime_html

router = APIRouter()


@router.get("/runtime")
async def runtime():
    return {"html": await asyncio.to_thread(runtime_html)}


@router.post("/canvas/result")
async def canvas_result(body: dict):
    req = str(body.get("req") or "")
    result = body.get("result") if isinstance(body.get("result"), dict) else {}
    if len(str(result.get("png") or "")) > 8_000_000:  # a canvas picture is well under this
        result = {**result, "png": None}
    await asyncio.to_thread(canvas.save_result, req, result)
    return {"ok": True}


@router.post("/paper")
async def paper(body: dict):
    url = str(body.get("url") or "")[:500]
    if not canvas.PAPER_URL.match(url):
        raise HTTPException(400, "Only arXiv HTML papers (arxiv.org/html or ar5iv).")
    title = " ".join(str(body.get("title") or "").split())[:300]
    await asyncio.to_thread(canvas.save_paper, url, title, str(body.get("text") or "")[:600000])
    return {"ok": True}


@router.get("/voice/{file}")
async def voice(file: str):
    src = await asyncio.to_thread(turns.voice_data, file)
    if not src:
        raise HTTPException(404, "no such sentence")
    return {"src": src}


@router.post("/state")
async def state(body: dict):
    await asyncio.to_thread(canvas.save_state, "state", {"armed": bool(body.get("armed")), "live": str(body.get("live") or "")[:40]})
    return {"ok": True}


@router.post("/selection")
async def selection(body: dict):
    data = {k: str(body.get(k) or "")[:6000 if k == "text" else 500] for k in ("id", "text", "url", "section", "paperTitle")}
    data["ask"] = bool(body.get("ask"))
    if not data["id"].startswith("pa-") or len(data["text"]) < 15:
        raise HTTPException(400, "bad selection")
    await asyncio.to_thread(canvas.save_state, "selection", data)
    return {"ok": True}
