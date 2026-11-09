# Paper Animations: Hermes inside the paper

**Your agent, with the whole paper in its head, drawing a live figure you can touch.**

Highlight a passage in an arXiv paper in Hermes's browser. Your own Hermes session gives you the gist like a smart friend at a whiteboard: it talks you through the core idea while it sketches a live, interactive figure right under the paragraph, built from the paper's own example and numbers. Ask a follow-up (typed or out loud) and it keeps drawing on the same sketch.

It is not a video generator and not a separate app: it gives Hermes a new ability, **a canvas inside what you're reading**, plus a voice that stays in sync with the drawing.

## Try it
1. Install it with `hermes plugins install paper-animations`, then turn it on in Hermes Desktop (Capabilities → Plugins → Paper Animations → On). Needs Hermes Desktop 0.22.6 or newer.
2. Open an arXiv paper's HTML version in Hermes's browser (`arxiv.org/html/…`, or `ar5iv.labs.arxiv.org/html/…` for papers arXiv itself hasn't converted), with a Hermes chat next to it.
3. Click **✨ Paper Animations** in the status bar (Desktop asks once to let it run on arxiv.org).
4. Highlight a passage, then:
   - **✨ Visualize**: Hermes explains it and draws.
   - **💬 Ask**: the passage lands in your Hermes chat as a draft; add your question (type or dictate) and send. In a Hermes voice conversation you can also just say it.
5. Keep asking in the chat or out loud; Hermes answers and changes the same figure.
6. Click **LIVE** on the figure to leave: Hermes chats normally again, without voice or drawing. **Resume** brings it back.

Leave Hermes Desktop's "Read replies aloud" off: the plugin speaks Hermes's replies itself, sentence by sentence, in sync with the drawing.

## How it works
Everything runs in your own Hermes session, with your model and your settings. The plugin adds:

| Piece | What it does |
|---|---|
| `canvas_draw(canvas, say, code)` | One step of the figure: `code` is a small piece of JavaScript drawn on the canvas under the paragraph (D3 and KaTeX available; names persist across calls like notebook cells), and `say` is what Hermes says as that piece appears. |
| `canvas_look(canvas)` | A picture of the canvas plus a layout report, for when Hermes is unsure how its figure looks. Every drawing step also reports overlapping or cut-off labels. |
| `canvas_clear(canvas)` | Start over (the old drawing fades away). |
| `paper_read(url, offset)` | The paper's full text (formulas as LaTeX, tables cell by cell), in chunks. |
| Hooks on Hermes's turns | Hermes calls them on every turn; they act only on **paper turns** and return at once otherwise. A paper turn is a ✨ Visualize / 💬 Ask message, a question spoken right after 💬 Ask, or a follow-up in the chat that owns the **LIVE** figure; only Desktop or local chats qualify (never cron, messaging platforms or subagents), and only while the plugin is on. On a paper turn they add the skill and the paper around the passage to that message (for the model only), voice Hermes's text sentence by sentence and each step's `say` with Hermes's `text_to_speech`, and show each drawing step as its sentence starts. Outside a paper turn the figure tools are refused. |
| A skill (`paper-animations:paper-canvas`) | The guidance itself: find the passage's key idea in the context of the paper, give the gist and the why, and build one concrete example on the board. Edit `skills/paper-canvas/SKILL.md` to change the style. |

## Security model
- **The drawing code** is written by your own model and runs only inside a sandboxed iframe in the card (`sandbox="allow-scripts"`, opaque origin, CSP `default-src 'none'`). It has no access to the paper page, Hermes, your chat, your files or cookies; it can't fetch or load anything, open windows or submit forms; it can only draw and report back to the waiting tool (done, an error, layout warnings, or a picture for `canvas_look`). Best effort beyond that: CSP doesn't govern a frame navigating itself or WebRTC, so code is checked before it runs (`location`, `fetch`, WebRTC and similar are refused) and a figure that navigates away anyway is removed. A model that has been talked into leaking data could still try; it would have Hermes's own web tools for that too, so the sandbox adds no new reach.
- **Paper text is untrusted.** The highlighted passage and the paper text around it are web content; the plugin labels both for the model as reference material whose instructions must never be followed. Hidden prompt-injection text in a paper is still a risk any agent reading the web has.
- **Messages come from your clicks.** Visualize, Ask, LIVE and close act on real clicks only, the in-page script is a frozen, read-only object installed under a random name, and every event from the page is checked (an arXiv paper, a card id, bounded text) before anything is sent to your chat. This is best effort against scripts that arxiv.org itself serves: the page you allow is trusted to that extent.
- **Other chats are left alone.** Cron, messaging platforms and subagents never get paper turns, a figure belongs to the chat it was made in, and the figure tools are refused outside paper turns and fail at once when no Desktop paper is on.

## What it touches (disclosure)
- **The paper page:** reads the page you're on (arXiv HTML pages only: arxiv.org/html and ar5iv) with Desktop's per-site consent, adds the buttons and the figure card under the paragraph. Nothing else on the page is changed.
- **Your Hermes session:** sends ✨ Visualize / 💬 Ask messages to the chat you have open, as if you typed them; adds paper context to those turns (visible to the model only).
- **Your model:** whatever Hermes is configured to use. The passage and nearby paper text go to it as part of the turn.
- **Voice:** Hermes's own `text_to_speech` with your configured provider, one call per spoken sentence (Edge TTS by default, a free online Microsoft service; a paid provider bills each sentence).
- **Stored data:** in the plugin's data folder of your active Hermes profile (`<HERMES_HOME>/plugin-data/paper-animations/`, usually `~/.hermes/…`): the text of the 20 most recently opened papers, the current Ask, whether the plugin is on and which figure is LIVE (re-confirmed every ~20 s while Desktop runs), and short-lived files (voiced sentences, removed after about a day; tool answers, after about an hour; cleaned up during use). No telemetry.
- **When the paper isn't open** (Desktop closed or crashed, the chip off, cron or messaging runs): the canvas tools fail at once with a short message and the hooks do nothing.
- No credentials, no external CLIs, no downloads, no binaries.

## Reliability
In testing with Claude Opus on *Attention Is All You Need* and other arXiv papers: the first spoken sentence comes about 6–8 s after the click, a full explanation with three drawing steps takes about a minute, and a spoken follow-up redraws the figure in about the same time. Voice is synthesised a few sentences at a time, so it keeps pace with the drawing; a sentence that can't be voiced is shown as a caption instead.

## License
MIT (see `LICENSE`). Vendored, unmodified, in `figure_runtime/vendor/`: D3 7.9.2 (ISC), KaTeX 0.16.47 (MIT, with its fonts), acorn 8.19.0 (MIT).
