"""Assemble the sandboxed figure runtime (one HTML page) from its readable parts:
template.html + runtime.js + vendored d3 / katex / acorn, with KaTeX's fonts inlined as data URLs
(the sandbox has no network). Built on request and cached; nothing is fetched from the internet.
"""
import base64
import functools
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


@functools.lru_cache(maxsize=1)
def runtime_html() -> str:
    vendor = "\n;\n".join((VENDOR / f).read_text() for f in ("d3.min.js", "katex.min.js", "acorn.js"))
    # "</script" can't appear inside an inline script; the vendored code is escaped so it stays one block.
    vendor = vendor.replace("</script", "<\\/script")
    html = (HERE / "template.html").read_text()
    return (html.replace("/*KATEX_CSS*/", _katex_css())
                .replace("/*VENDOR_JS*/", vendor)
                .replace("/*RUNTIME_JS*/", (HERE / "runtime.js").read_text()))

