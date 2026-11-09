"""Paper Animations, agent half: Hermes's pen in the paper.

Registers small canvas tools (draw a step, look at it, clear it) plus paper_read, the skill that teaches Hermes
how to sketch the figure a passage should have had, and hooks that give our turns the paper quietly and a live
voice (paper_anim/turns.py). The desktop half (desktop/plugin.js) hosts the canvas
inside the paper and sends highlights and questions to the user's own Hermes session.
"""
from pathlib import Path

from .paper_anim import canvas, turns
from .paper_anim.canvas import HANDLERS, SCHEMAS

TOOLSET = "paper-animations"


def register(ctx):
    turns.CTX = ctx
    canvas.prune()
    # Our turns only (a highlight or a question asked in the figure): quiet paper context in, live voice out.
    for hook in ("pre_llm_call", "pre_tool_call", "on_stream_delta", "on_stream_end", "post_llm_call"):
        ctx.register_hook(hook, getattr(turns, hook))
    for name, schema in SCHEMAS.items():
        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=HANDLERS[name])
    skills = Path(__file__).parent / "skills"
    for child in sorted(skills.iterdir()) if skills.exists() else []:
        if child.is_dir() and (child / "SKILL.md").exists():
            ctx.register_skill(child.name, child / "SKILL.md")
