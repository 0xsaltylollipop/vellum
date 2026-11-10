# Vellum: Hermes draws inside the paper

**Your agent, with the whole paper in its head, drawing a live figure you can touch.**

*Vellum is the parchment medieval scribes illuminated: they drew living pictures right into the text to explain it. This plugin gives Hermes that pen.*

Highlight a passage in an arXiv paper in Hermes's browser. Your own Hermes session gives you the gist like a smart friend at a whiteboard: it talks you through the core idea while it sketches a live, interactive figure right under the paragraph, built from the paper's own example and numbers. Ask a follow-up (typed or out loud) and it keeps drawing on the same sketch.

It is not a video generator and not a separate app: it gives Hermes a new ability, **a canvas inside what you're reading**, plus a voice that stays in sync with the drawing.

## Try it
1. Install it with `hermes plugins install vellum`, then turn it on in Hermes Desktop (Capabilities → Plugins → Vellum → On). Needs Hermes Desktop 0.22.7 or newer.
2. Open an arXiv paper's HTML version in Hermes's browser (`arxiv.org/html/…`, or `ar5iv.labs.arxiv.org/html/…` for papers arXiv itself hasn't converted), with a Hermes chat next to it.
3. Click **✨ Vellum** in the status bar (Desktop asks once to let it run on arxiv.org, and once more for ar5iv). Desktop asks for each site, so clicking it on any other page asks about that site: say no there. Vellum only works on arXiv HTML papers and switches itself off when you navigate away.
4. Highlight a passage, then:
   - **✨ Visualize**: the request lands in your Hermes chat box as a draft; press Enter and Hermes explains it and draws.
   - **💬 Ask**: the passage lands in your Hermes chat box as a draft; add your question (type or dictate) and send. In a Hermes voice conversation you can also just say it.

   Vellum never sends a chat message for you: every turn starts with you pressing Enter (or speaking).
5. Keep asking in the chat or out loud; Hermes answers and changes the same figure.
6. Click **LIVE** on the figure to leave: Hermes chats normally again, without voice or drawing. **Resume** brings it back.

Leave Hermes Desktop's "Read replies aloud" off: the plugin speaks Hermes's replies itself, sentence by sentence, in sync with the drawing.

## How it works
Everything runs in your own Hermes session, with your model and your settings. The plugin adds:

| Piece | What it does |
|---|---|
| `vellum_draw(canvas, say, code)` | One step of the figure: `code` is a small piece of JavaScript drawn on the canvas under the paragraph (D3 and KaTeX available; names persist across calls like notebook cells), and `say` is what Hermes says as that piece appears. |
| `vellum_look(canvas)` | A picture of the canvas plus a layout report, for when Hermes is unsure how its figure looks. Every drawing step also reports overlapping or cut-off labels. |
| `vellum_clear(canvas)` | Start over (the old drawing fades away). |
| `vellum_read(url, offset)` | The paper's full text (formulas as LaTeX, tables cell by cell), in chunks. |
| Hooks on Hermes's turns | Hermes calls them on every turn; they act only on **paper turns** and return at once otherwise. A paper turn is a ✨ Visualize / 💬 Ask message for a figure card you opened with a click in Desktop (a message that only looks like one is an ordinary message, and a card belongs to the chat that sends it first), a question spoken right after 💬 Ask in the same chat, or a follow-up in the chat that owns the **LIVE** figure; only interactive local chats qualify (Desktop, or Hermes's own terminal and web chat; never cron, messaging platforms, subagents or a turn that names no platform), and only while the plugin is on. On a paper turn they add the skill and the paper around the passage to that message (for the model only), voice Hermes's text sentence by sentence and each step's `say` with Hermes's `text_to_speech`, and show each drawing step as its sentence starts. Outside a paper turn the figure tools are refused, and inside one they work on that turn's figure only. |
| A skill (`vellum:paper-canvas`) | The guidance itself: find the passage's key idea in the context of the paper, give the gist and the why, and build one concrete example on the board. Edit `skills/paper-canvas/SKILL.md` to change the style. |

## Why a plugin and not a prompt
A prompt can ask a model to explain a passage. It can't do the rest:
- **Draw inside the page you're reading.** That takes the Desktop half (the card under the paragraph) and the canvas tools.
- **Keep the drawing in step with the voice.** The hooks on Hermes's stream voice each sentence as it is written, and each drawing step is held back until its sentence starts playing.
- **Know the paper, on the right turns only.** `pre_llm_call` hands the model the paper around the passage on paper turns and stays out of every other chat.
- **Run model-written code safely.** The figure runs in a sandboxed frame that can't reach the page, your session or the network.

The skill is the one part that is a prompt, and you can edit it.

## Security model
- **The drawing code** is written by your own model and runs only inside a sandboxed iframe in the card (`sandbox="allow-scripts"`, opaque origin, CSP `default-src 'none'` with the page's two scripts listed by hash). It has no access to the paper page, Hermes, your chat, your files or cookies; it can't fetch or load anything, open windows or submit forms; it can only draw and report back to the waiting tool (done, an error, layout warnings, or a picture for `vellum_look`, all bounded in size). Two things the sandbox and the CSP don't govern are handled as best effort:
  - **WebRTC.** Its constructors are removed from the figure's window. A frame created inside the figure would get fresh ones, but it inherits the CSP, and since that lists scripts by hash, such a frame can't run a script of its own to use them. (A side effect: inline handler attributes like `onclick="…"` don't run in figures; `addEventListener` and D3's `.on()` do.)
  - **A frame navigating itself.** Nothing in CSP prevents it, so the card removes a figure that navigates away.

  Two more checks exist for the model's benefit, not as boundaries. Code that names `location`, `fetch` and similar is refused before it runs, so the model gets a clear error to fix; a computed name gets past it. And loops that keep the page busy for more than 3 s are stopped, so a runaway loop doesn't freeze the figure; deep recursion or one huge built-in call isn't covered. A model that has been talked into leaking data could still try; it would have Hermes's own web tools for that too, so the sandbox adds no new reach.
- **Paper text is untrusted.** The highlighted passage and the paper text around it are web content; the plugin labels both for the model as reference material whose instructions must never be followed, and text in them shaped like the plugin's own notes to the model loses that shape before it is added. Hidden prompt-injection text in a paper is still a risk any agent reading the web has.
- **You send every message.** A click on Visualize or Ask only puts a draft into your Hermes chat box; the plugin never submits a chat turn, so nothing in a web page can start one. Visualize, Ask, LIVE and close act on real clicks only. The in-page script is a frozen, read-only object that answers only calls carrying a secret the plugin makes at each install and never stores on the page. Every event from the page is checked (an arXiv paper's address, a card id, bounded text) before anything is put into your chat box, the card is registered with the plugin's backend before its draft exists (only registered cards start paper turns, so typing or pasting a lookalike draft does nothing special), and a draft's first line holds only that checked address and the card id: the paper's title and section name are page text, so they go into the quote with the passage. This is best effort against scripts that arxiv.org itself serves: a script running in the same page can't be fully kept out of what the in-page script sees, which is why the checks sit on the plugin's side and every message waits for you to send it.
- **Other chats are left alone.** Cron, messaging platforms and subagents never get paper turns, a figure belongs to the chat it was made in, a turn can change only its own figure, and the figure tools are refused outside paper turns and fail at once when no Desktop paper is on.

## What it touches (disclosure)
- **The paper page:** reads the page you're on (arXiv HTML pages only: arxiv.org/html and ar5iv) with Desktop's per-site consent, adds the buttons and the figure card under the paragraph. Nothing else on the page is changed.
- **Your Hermes session:** puts ✨ Visualize / 💬 Ask drafts into the chat box of the chat you have open, for you to send; adds paper context to those turns (visible to the model only).
- **Your model:** whatever Hermes is configured to use. The passage and nearby paper text go to it as part of the turn.
- **Voice:** Hermes's own `text_to_speech` with your configured provider, one call per spoken sentence, at most 60 per turn; further sentences are shown as captions (Edge TTS by default, a free online Microsoft service; a paid provider bills each sentence).
- **Stored data:** in the plugin's data folder of your active Hermes profile (`<HERMES_HOME>/plugin-data/vellum/`, usually `~/.hermes/…`): the text of the 20 most recently opened papers, the ids of the 50 most recent figure cards you opened (with the paper and the chat they were opened in), the current Ask, whether the plugin is on and which figure is LIVE (re-confirmed every ~20 s while Desktop runs), and short-lived files (voiced sentences, removed after about a day; tool answers, after about an hour; cleaned up during use). No telemetry.
- **When the paper isn't open** (Desktop closed or crashed, the chip off, cron or messaging runs): the canvas tools fail at once with a short message and the hooks do nothing.
- No credentials, no external CLIs, no downloads, no binaries.

## Reliability
In testing with Claude Opus on *Attention Is All You Need* and other arXiv papers: the first spoken sentence comes about 6–8 s after the click, a full explanation with three drawing steps takes about a minute, and a spoken follow-up redraws the figure in about the same time. Voice is synthesised a few sentences at a time, so it keeps pace with the drawing; a sentence that can't be voiced is shown as a caption instead.

## License
MIT (see `LICENSE`). Vendored, unmodified, in `figure_runtime/vendor/`: D3 7.9.2 (ISC), KaTeX 0.16.47 (MIT, with its fonts), acorn 8.19.0 (MIT).
