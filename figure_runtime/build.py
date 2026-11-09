"""Assemble the sandboxed figure runtime (one HTML page) from its readable parts:
template.html + runtime.js + vendored d3 / katex / acorn, with KaTeX's fonts inlined as data URLs
(the sandbox has no network). Built on request and cached; nothing is fetched from the internet.

The page's CSP lists its two scripts by hash instead of allowing any inline script. Figure code still runs (the
runtime evaluates it, which 'unsafe-eval' allows), but a frame created inside the figure inherits this policy and
can't run a script of its own, and inline handler attributes (onclick="…") don't run either.
"""
import base64
import functools
import hashlib
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor"


def _katex_css() -> str:
    css = (VENDOR / "katex.min.css").read_text()

    def inline(m):
        name = m.group(1)
        font = VENDOR / "fonts" / name
        return f"url(data:font/woff2;base64,{base64.b64encode(font.read_bytes()).decode()}) format(\"woff2\")" if font.exists() else ""

    css = re.sub(r"url\(fonts/([\w-]+\.woff2)\) format\(\"woff2\"\)", inline, css)
    return re.sub(r",?\s*url\(fonts/[\w-]+\.(?:woff|ttf)\) format\(\"(?:woff|truetype)\"\)", "", css)


def _script(text: str) -> str:
    # The browser hashes a script exactly as it parsed it: line ends are normalised to "\n" on the way in.
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _hash(script: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode() + "'"


@functools.lru_cache(maxsize=1)
def runtime_html() -> str:
    vendor = "\n;\n".join((VENDOR / f).read_text(encoding="utf-8") for f in ("d3.min.js", "katex.min.js", "acorn.js"))
    # "</script" can't appear inside an inline script; the vendored code is escaped so it stays one block.
    vendor = _script(vendor.replace("</script", "<\\/script"))
    runtime = _script((HERE / "runtime.js").read_text(encoding="utf-8"))
    html = (HERE / "template.html").read_text(encoding="utf-8")
    return (html.replace("/*SCRIPT_HASHES*/", f"{_hash(vendor)} {_hash(runtime)}")
                .replace("/*KATEX_CSS*/", _katex_css())
                .replace("/*VENDOR_JS*/", vendor)
                .replace("/*RUNTIME_JS*/", runtime))

