// Vellum, desktop half: Hermes's canvas inside the paper.
// Highlight a passage on an arXiv paper (arxiv.org/html or ar5iv) -> "Visualize" -> a card with an empty canvas unfolds under the
// paragraph and the passage goes to the user's own Hermes session as a turn. Hermes talks (in chat / by voice)
// and draws on the canvas step by step with its canvas tools (paper_anim/canvas.py), whose requests arrive here
// as plugin events. The drawing code runs only inside a sandboxed iframe in the card, which can draw and report back,
// never send anything to Hermes; this file only relays data through ctx.preview.executeJavaScript.
// Loaded uncompiled by Hermes Desktop: no JSX, only @hermes/plugin-sdk / react / react/jsx-runtime imports.
import { host, atom, useValue, STATUSBAR_AREAS, SandboxedFrame } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

// Runs INSIDE the arXiv page (serialized with toString), so it must be self-contained.
// Returns the object the plugin installs as a read-only window property. Scripts on the page can find that object,
// so it has one entry point, and that only answers calls carrying `secret`: a value the plugin makes for each
// install and passes in here, which page scripts never see.
function vellumInPage(secret) {
  var queue = []
  var waiter = null
  var btn = null
  var pending = null
  var cards = {}
  var pageTag = Math.random().toString(16).slice(2, 6)  // canvas ids stay unique across page loads
  var nextCard = 1
  var runtimeHtml = null
  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim() }

  function deliver(ev) {
    if (waiter) { var w = waiter; waiter = null; w(ev) } else { queue.push(ev) }
  }

  // A drag to the end of a paragraph often ends the selection at offset 0 of the NEXT element (e.g. the next
  // heading), so the end point lies. Use the last text node that actually has highlighted characters.
  function lastSelectedElement(range) {
    var root = range.commonAncestorContainer
    if (root.nodeType !== 1) root = root.parentElement
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    var last = null
    var n
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue
      if (n === range.endContainer && range.endOffset === 0) continue
      if (!n.textContent.trim() || n.parentElement.closest('.pa-card')) continue
      last = n
    }
    var el = last || range.endContainer
    return el.nodeType === 1 ? el : el.parentElement
  }

  // A DOM fragment as plain text, with formulas as LaTeX (MathML alttext) and our own cards left out.
  function textOf(frag) {
    frag.querySelectorAll('.pa-card').forEach(function (c) { c.remove() })
    frag.querySelectorAll('math').forEach(function (m) {
      var tex = m.getAttribute('alttext') || ''
      var block = m.getAttribute('display') === 'block'
      m.replaceWith(document.createTextNode(block ? ' $$' + tex + '$$ ' : ' $' + tex + '$ '))
    })
    return clean(frag.textContent)
  }

  // Selection -> text with formulas as LaTeX, plus where it sits in the paper.
  // Whether the highlight covers any of el's text. A drag to the end of a paragraph often ends at offset 0 of the next
  // one: that one is "touched" but has nothing selected, so it isn't part of the passage.
  function hasSelectedText(range, el) {
    if (!range.intersectsNode(el)) return false
    var r = document.createRange()
    r.selectNodeContents(el)
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset)
    return r.toString().trim().length > 0
  }

  function capture() {
    var sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    var range = sel.getRangeAt(0)
    var text = textOf(range.cloneContents())
    if (text.length < 15) return null
    // Where the highlight ends decides both the section label and where the card goes.
    var end = lastSelectedElement(range)
    var section = end.closest('section')
    var secTitle = section ? section.querySelector('.ltx_title') : null
    var block = end.closest('.ltx_para') || end.closest('.ltx_equation, .ltx_equationgroup, figure, .ltx_theorem, li, p') || end
    // Every paragraph (and display equation) the highlight touches gets the yellow marker, not just the last one.
    var source = Array.prototype.filter.call(document.querySelectorAll('.ltx_para, .ltx_equation, .ltx_equationgroup'), function (el) {
      return hasSelectedText(range, el) && !el.parentElement.closest('.ltx_para')
    }).slice(0, 30)
    if (!source.length) source = [block]
    var docTitle = document.querySelector('.ltx_title_document')
    var lines = Array.prototype.filter.call(range.getClientRects(), function (r) { return r.width > 0 && r.height > 0 })
    return {
      text: text,
      url: location.href,
      paperTitle: docTitle ? clean(docTitle.textContent) : document.title,
      section: secTitle ? clean(secTitle.textContent) : '',
      block: block,
      source: source,
      box: range.getBoundingClientRect(),
      lastLine: lines.length ? lines[lines.length - 1] : range.getBoundingClientRect()
    }
  }

  // Bump STYLE_V when the CSS changes: a page that already has an older copy (from before a plugin update) gets the new one.
  var STYLE_V = '13'
  function ensureStyle() {
    var st = document.getElementById('pa-style')
    if (st && st.getAttribute('data-v') === STYLE_V) return
    if (st) st.remove()
    st = document.createElement('style')
    st.id = 'pa-style'
    st.setAttribute('data-v', STYLE_V)
    // Hermes's own look (hermes-agent.nousresearch.com): deep navy panels, a thin electric-blue edge, small
    // uppercase labels, crisp condensed type. Fonts fall back to the closest system faces.
    var LABEL = "'Aeonik Fono Pro','SF Mono',ui-monospace,Menlo,monospace"
    // Engraved capitals for the buttons (old-world; falls back through the classical system serifs)
    var RUNE = "'Cinzel','Trajan Pro','Optima','Palatino','Palatino Linotype','Book Antiqua',Georgia,serif"
    // The panel's own edge glow (the moving smoke is .pa-smoke behind it).
    var SMOKE = '0 0 0 1px rgba(61,90,254,.35),0 0 18px rgba(0,0,242,.35),0 0 2px rgba(94,234,255,.25)'
    st.textContent = [
      // The card is a transparent shell (its own stacking context): the navy panel is ::after, the smoke sits behind it.
      '.pa-card{position:relative;isolation:isolate;margin:40px 0 44px;padding:11px 13px 13px;color:#F2F2F2;',
      'font:14px/1.5 -apple-system,system-ui,sans-serif;animation:pa-emerge 1.2s cubic-bezier(.2,.7,.2,1) both}',
      '.pa-card::after{content:"";position:absolute;inset:0;z-index:-1;border:1px solid #2B3BFF;border-radius:4px;pointer-events:none;',
      'background:radial-gradient(120% 60% at 12% 0%,rgba(61,90,254,.20),transparent 60%),radial-gradient(90% 50% at 95% 100%,rgba(94,234,255,.08),transparent 65%),#19192F;',
      'box-shadow:' + SMOKE + ';animation:pa-flash 2.2s ease-out .35s both}',
      // Smoke: two blurred layers of blue, turquoise and violet plumes, each drifting on its own slow loop.
      '.pa-smoke{position:absolute;inset:-38px;z-index:-2;pointer-events:none;animation:pa-billow 2s ease-out both}',
      '.pa-smoke::before,.pa-smoke::after{content:"";position:absolute;inset:0;border-radius:48px;filter:blur(22px);will-change:transform,opacity}',
      '.pa-smoke::before{background:radial-gradient(38% 28% at 8% 12%,rgba(45,52,150,.55),transparent 70%),radial-gradient(34% 30% at 92% 88%,rgba(6,6,16,.7),transparent 70%),',
      'radial-gradient(28% 22% at 66% 4%,rgba(75,50,130,.45),transparent 70%),radial-gradient(24% 32% at 2% 70%,rgba(45,110,120,.35),transparent 70%);animation:pa-drift-a 16s ease-in-out infinite alternate}',
      '.pa-smoke::after{background:radial-gradient(32% 26% at 88% 14%,rgba(45,110,120,.4),transparent 70%),radial-gradient(38% 28% at 14% 92%,rgba(45,52,150,.5),transparent 70%),',
      'radial-gradient(26% 22% at 52% 99%,rgba(6,6,16,.65),transparent 70%),radial-gradient(22% 32% at 99% 50%,rgba(75,50,130,.4),transparent 70%);animation:pa-drift-b 22s ease-in-out infinite alternate}',
      '@keyframes pa-drift-a{0%{transform:translate(-3%,-2%) scale(1);opacity:.7}35%{transform:translate(2%,1%) scale(1.04);opacity:1}70%{transform:translate(-1%,3%) scale(.97);opacity:.8}100%{transform:translate(3%,-1%) scale(1.02);opacity:.95}}',
      '@keyframes pa-drift-b{0%{transform:translate(3%,2%) scale(1.03);opacity:.9}40%{transform:translate(-2%,-2%) scale(.98);opacity:.65}75%{transform:translate(1%,-3%) scale(1.05);opacity:1}100%{transform:translate(-3%,1%) scale(1);opacity:.75}}',
      '@media (prefers-reduced-motion: reduce){.pa-smoke,.pa-smoke::before,.pa-smoke::after,.pa-card,.pa-glow{animation:none}}',
      // Arrival: the smoke billows out first and settles into its drift; the panel resolves out of it, from a blur.
      '@keyframes pa-emerge{0%{opacity:0;filter:blur(14px);transform:translateY(10px) scale(.985)}45%{opacity:.85}100%{opacity:1;filter:none;transform:none}}',
      '@keyframes pa-billow{0%{opacity:0;transform:scale(.8)}35%{opacity:1;transform:scale(1.18)}100%{opacity:1;transform:none}}',
      // Hermes's frame bloom: one flash of electric blue when the card arrives (nothing animates while you read)
      '@keyframes pa-flash{0%{box-shadow:0 0 0 1px rgba(61,90,254,.7),0 0 34px 2px rgba(0,0,242,.35)}100%{box-shadow:' + SMOKE + '}}',
      // The highlight buttons, old-world: engraved serif capitals on dusky indigo, wrapped in murky smoke. Four wisps
      // (deep indigo, shadow, dim violet, muted teal) circle the pair at different speeds and directions.
      '.pa-bar{isolation:isolate;animation:pa-bar-in .5s ease-out}',
      '@keyframes pa-bar-in{from{opacity:0;filter:blur(6px)}to{opacity:1;filter:none}}',
      '.pa-bar::before,.pa-bar::after,.pa-mist::before,.pa-mist::after{content:"";position:absolute;z-index:-1;pointer-events:none;width:170px;height:100px;left:50%;top:50%;margin:-50px 0 0 -85px;border-radius:50%;filter:blur(20px)}',
      '.pa-mist{position:absolute;inset:0;z-index:-1;pointer-events:none}',
      '.pa-bar::before{background:radial-gradient(closest-side,rgba(45,52,150,.6),rgba(45,52,150,.2) 60%,transparent);animation:pa-orbit 9s linear infinite}',
      '.pa-bar::after{background:radial-gradient(closest-side,rgba(6,6,16,.75),rgba(6,6,16,.3) 60%,transparent);animation:pa-orbit 13s linear infinite reverse}',
      '.pa-mist::before{background:radial-gradient(closest-side,rgba(75,50,130,.5),rgba(75,50,130,.15) 60%,transparent);animation:pa-orbit2 17s linear infinite}',
      '.pa-mist::after{width:120px;height:70px;margin:-35px 0 0 -60px;background:radial-gradient(closest-side,rgba(45,110,120,.4),transparent);animation:pa-orbit2 11s linear infinite reverse}',
      '@keyframes pa-orbit{0%{transform:translate(-80px,-14px) scale(1.15)}25%{transform:translate(0,-32px) scale(.85)}50%{transform:translate(80px,-4px) scale(1.2)}75%{transform:translate(0,28px) scale(.9)}100%{transform:translate(-80px,-14px) scale(1.15)}}',
      '@keyframes pa-orbit2{0%{transform:translate(60px,24px) scale(.9)}25%{transform:translate(-10px,30px) scale(1.15)}50%{transform:translate(-85px,0) scale(1)}75%{transform:translate(10px,-30px) scale(1.2)}100%{transform:translate(60px,24px) scale(.9)}}',
      '.pa-btn{position:relative;cursor:pointer;border-radius:3px;text-transform:uppercase;font:500 12.5px/1 ' + RUNE + ';letter-spacing:1.8px;padding:8px 14px 7px;',
      'color:#D9DEF7;background:linear-gradient(180deg,#262B66,#14163A);border:1px solid rgba(125,140,225,.55);',
      'text-shadow:0 0 6px rgba(130,150,255,.45);transition:color .3s,border-color .3s,text-shadow .3s;animation:pa-aura 5s ease-in-out infinite alternate}',
      '.pa-btn.ask{color:#CFE0E3;background:linear-gradient(180deg,#1C1E40,#101126);border-color:rgba(90,150,160,.42);text-shadow:0 0 6px rgba(90,180,190,.35);animation-name:pa-aura-soft}',
      '.pa-btn:hover{color:#F0F2FF;border-color:rgba(160,175,255,.8);text-shadow:0 0 9px rgba(150,170,255,.75)}',
      '.pa-btn.ask:hover{color:#E4F3F5;border-color:rgba(110,190,200,.65);text-shadow:0 0 9px rgba(110,200,210,.6)}',
      '@keyframes pa-aura{0%{box-shadow:0 0 10px rgba(30,36,120,.5),inset 0 1px 0 rgba(180,190,255,.12)}100%{box-shadow:0 0 18px rgba(45,55,160,.6),inset 0 1px 0 rgba(180,190,255,.18)}}',
      '@keyframes pa-aura-soft{0%{box-shadow:0 0 8px rgba(30,90,100,.3),inset 0 1px 0 rgba(150,210,220,.08)}100%{box-shadow:0 0 14px rgba(40,110,120,.4),inset 0 1px 0 rgba(150,210,220,.12)}}',
      '@media (prefers-reduced-motion: reduce){.pa-btn,.pa-bar::before,.pa-bar::after,.pa-mist::before,.pa-mist::after,.pa-live{animation:none}}',
      '.pa-head{display:flex;align-items:center;gap:10px;margin:0 2px 8px;font:500 10.5px/1 ' + LABEL + ';letter-spacing:.9px;text-transform:uppercase;color:#A9ABD6}',
      '.pa-head .pa-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pa-head .pa-title b{color:#F2F2F2;font-weight:600;margin-right:2px}',
      '.pa-head .pa-status{display:flex;align-items:center;gap:7px;color:#A9ABD6}',
      '.pa-dot{width:6px;height:6px;border-radius:1px;background:#3D5AFE;box-shadow:0 0 8px #3D5AFE;animation:pa-pulse 1.1s ease-in-out infinite}',
      '.pa-status.done .pa-dot{display:none}',
      '.pa-status.error .pa-dot{animation:none;background:#FC6255;box-shadow:none}',
      '@keyframes pa-pulse{0%,100%{opacity:.25}50%{opacity:1}}',
      '.pa-close{border:none;background:none;color:#A9ABD6;font:14px/1 ' + LABEL + ';cursor:pointer;padding:2px 4px}',
      '.pa-close:hover{color:#F2F2F2}',
      '.pa-fig iframe{width:100%;height:560px;border:0;display:block;background:#19192F;border-radius:2px;transition:height .7s cubic-bezier(.2,.7,.2,1)}',
      // The passage Hermes is talking about: one soft glowing box behind it, with room around the letters.
      '.pa-glow{position:absolute;z-index:-1;pointer-events:none;border-radius:8px;background:rgba(61,90,254,.11);',
      'box-shadow:0 0 0 1px rgba(61,90,254,.45),0 0 30px 4px rgba(0,0,242,.26),inset 0 0 26px rgba(94,234,255,.07);animation:pa-glow-in 1.8s ease-out both}',
      // the passage glow bleeds in like ink: from a soft blur, with one slow swell of light
      '@keyframes pa-glow-in{0%{opacity:0;filter:blur(10px);transform:scale(.97)}55%{opacity:1;box-shadow:0 0 0 1px rgba(94,234,255,.4),0 0 40px 6px rgba(0,0,242,.24),inset 0 0 28px rgba(94,234,255,.1)}100%{opacity:1;filter:none;transform:none}}',
      // the LIVE pill: while it glows, what you say in the chat goes to this figure; click to leave
      '.pa-live{position:relative;display:flex;align-items:center;gap:7px;min-width:78px;justify-content:center;border-radius:3px;cursor:pointer;',
      'font:500 10.5px/1 ' + RUNE + ';letter-spacing:1.6px;text-transform:uppercase;padding:5px 10px 4px;transition:color .3s,background .3s,border-color .3s,text-shadow .3s}',
      '.pa-live i{width:5px;height:5px;border-radius:50%;background:#6FC7D0;box-shadow:0 0 6px rgba(111,199,208,.7);animation:pa-pulse 2.4s ease-in-out infinite}',
      '.pa-live.on{color:#CFE6EA;background:linear-gradient(180deg,rgba(45,110,120,.14),rgba(20,40,50,.1));border:1px solid rgba(90,170,180,.4);text-shadow:0 0 6px rgba(90,180,190,.35);box-shadow:0 0 10px rgba(30,90,100,.3)}',
      '.pa-live.on:hover{color:#ECEFF7;border-color:rgba(200,205,230,.5)}',
      '.pa-live.on:hover i{background:#C9CEE0;box-shadow:none;animation:none}',
      '.pa-live.off{color:#D9DEF7;background:linear-gradient(180deg,#262B66,#14163A);border:1px solid rgba(125,140,225,.55);text-shadow:0 0 6px rgba(130,150,255,.45);animation:pa-aura 5s ease-in-out infinite alternate}',
      '.pa-live.off i{display:none}',
      '.pa-live.off:hover{color:#F0F2FF;border-color:rgba(160,175,255,.8);text-shadow:0 0 9px rgba(150,170,255,.75)}'
    ].join('')
    document.head.appendChild(st)
  }

  // Mark the passage: one glowing box behind all the paragraphs it touches, padded so it never crowds the letters.
  // It lives in their common parent (made a stacking context, so the box sits above its background but below the
  // text) and follows reflows (a card opening above, a resize).
  var PAD_X = 14, PAD_Y = 10
  function placeGlow(c) {
    var g = c.glow
    if (!g) return
    var pr = g.parentElement.getBoundingClientRect()
    var u = null
    c.source.forEach(function (el) {
      var r = el.getBoundingClientRect()
      if (!r.width && !r.height) return
      u = u ? { l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom }
    })
    if (!u) return
    var bx = g.parentElement.clientLeft, by = g.parentElement.clientTop
    g.style.left = (u.l - pr.left - bx - PAD_X) + 'px'
    g.style.top = (u.t - pr.top - by - PAD_Y) + 'px'
    g.style.width = (u.r - u.l + 2 * PAD_X) + 'px'
    g.style.height = (u.b - u.t + 2 * PAD_Y) + 'px'
  }
  var glowWatch = window.ResizeObserver ? new ResizeObserver(function () { Object.keys(cards).forEach(function (id) { placeGlow(cards[id]) }) }) : null
  function markSource(c, on) {
    if (!c.source || !c.source.length) return
    if (!on) {
      if (c.glow) { var host = c.glow.parentElement; c.glow.remove(); c.glow = null; if (host && c.glowWas) { host.style.position = c.glowWas.position; host.style.isolation = c.glowWas.isolation } }
      return
    }
    var host = c.source[0].parentElement
    while (host && host !== document.body && !c.source.every(function (el) { return host.contains(el) })) host = host.parentElement
    if (!host) return
    c.glowWas = { position: host.style.position, isolation: host.style.isolation }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
    host.style.isolation = 'isolate'
    var g = document.createElement('div')
    g.className = 'pa-glow'
    host.appendChild(g)
    c.glow = g
    placeGlow(c)
    if (glowWatch) glowWatch.observe(host)
  }

  // LIVE: while a card is live, what the user says in the Hermes chat goes to it (one live card at a time).
  var liveId = null
  function setLive(id) {
    liveId = id && cards[id] ? id : null
    Object.keys(cards).forEach(function (k) {
      var b = cards[k].live, on = k === liveId
      b.className = 'pa-live ' + (on ? 'on' : 'off')
      b.lastChild.textContent = on ? 'Live' : 'Resume'
      b.title = on ? 'Your chat messages go to this figure. Click to leave and chat with Hermes normally.' : 'Talk to this figure again'
    })
    return true
  }

  // The card is created by the page itself on click, so it appears instantly; the plugin then fills it in.
  function createCard(found) {
    ensureStyle()
    var id = found.id || ('pa-' + pageTag + nextCard++)
    var card = document.createElement('div')
    card.className = 'pa-card'
    var head = document.createElement('div')
    head.className = 'pa-head'
    var title = document.createElement('span')
    title.className = 'pa-title'
    var brand = document.createElement('b')
    brand.textContent = 'Hermes'
    title.appendChild(brand)
    title.appendChild(document.createTextNode(' · ' + (found.section || 'Live figure')))
    var status = document.createElement('span')
    status.className = 'pa-status'
    var dot = document.createElement('i')
    dot.className = 'pa-dot'
    var statusText = document.createElement('span')
    statusText.textContent = 'Looking at the passage…'
    status.appendChild(dot)
    status.appendChild(statusText)
    var live = document.createElement('button')
    live.className = 'pa-live off'
    live.appendChild(document.createElement('i'))
    live.appendChild(document.createElement('span'))
    live.addEventListener('mouseenter', function () { if (liveId === id) live.lastChild.textContent = 'Leave' })
    live.addEventListener('mouseleave', function () { if (liveId === id) live.lastChild.textContent = 'Live' })
    live.addEventListener('click', function (e) {
      if (!e.isTrusted) return
      var on = liveId !== id
      setLive(on ? id : null)
      deliver({ type: 'live', cardId: id, on: on })
    })
    var close = document.createElement('button')
    close.className = 'pa-close'
    close.textContent = '✕'
    close.title = 'Close'
    close.addEventListener('click', function (e) {
      if (!e.isTrusted) return
      if (cards[id]) markSource(cards[id], false)
      var wasLive = liveId === id
      card.remove(); delete cards[id]
      if (wasLive) liveId = null
      deliver({ type: 'close', cardId: id, wasLive: wasLive })
    })
    head.appendChild(title)
    head.appendChild(status)
    head.appendChild(live)
    head.appendChild(close)
    var smoke = document.createElement('div')
    smoke.className = 'pa-smoke'
    card.appendChild(smoke)
    var fig = document.createElement('div')
    fig.className = 'pa-fig'
    card.appendChild(head)
    card.appendChild(fig)
    // Keep the passage's own equation next to it: if the next block is an equation (or a paragraph that opens
    // with one), the card goes after it, so the figure doesn't push the formula it explains off-screen.
    var anchor = found.block
    var isEq = function (el) {
      if (!el || el.classList.contains('pa-card')) return false
      if (el.matches('.ltx_equation, .ltx_equationgroup')) return true
      var first = el.firstElementChild
      return el.matches('.ltx_para') && !!first && first.matches('table.ltx_equation, table.ltx_equationgroup, .ltx_equation, .ltx_equationgroup')
    }
    while (isEq(anchor.nextElementSibling)) anchor = anchor.nextElementSibling
    anchor.after(card)
    cards[id] = { card: card, fig: fig, status: status, statusText: statusText, frame: null, ready: false, outbox: [], shown: false, source: found.source, live: live, n: 0, waits: {} }
    markSource(cards[id], true)
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    return id
  }

  // Once there's something to look at, bring the whole card into view (it can sit below the fold).
  function reveal(c) {
    if (c.shown) return
    c.shown = true
    setTimeout(function () { c.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, 300)
  }

  // The live figure: a sandboxed iframe (scripts only, opaque origin, no network) running the runtime page.
  function createFigure(c) {
    if (c.frame || !runtimeHtml) return
    var frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('title', 'Live figure')
    frame.srcdoc = runtimeHtml
    // The figure may only draw. If its code ever navigates the frame away, stop it: remove the frame and fail
    // whatever is waiting on it (srcdoc loads exactly once; any later load is a navigation).
    var loads = 0
    frame.addEventListener('load', function () {
      if (++loads < 2) return
      frame.remove(); c.frame = null; c.ready = false
      Object.keys(c.waits).forEach(function (k) { var w = c.waits[k]; delete c.waits[k]; w.done({ ok: false, error: 'The figure tried to leave its frame and was stopped. Figures can only draw.' }) })
      c.statusText.textContent = 'Figure stopped'
    })
    // It opens from nothing to about its real size (the 960x540 stage at the card's width, plus the caption), so the
    // paper below glides down instead of jumping; the figure then reports its exact height.
    frame.style.height = '0px'
    c.fig.appendChild(frame)
    c.frame = frame
    requestAnimationFrame(function () { frame.style.height = Math.round(c.fig.clientWidth * 540 / 960 + 96) + 'px' })
  }

  function toFigure(c, msg) {
    if (c.ready && c.frame) c.frame.contentWindow.postMessage(msg, '*'); else c.outbox.push(msg)
  }

  window.addEventListener('message', function (e) {
    var m = e.data
    if (!m || !m.pa) return
    var id = Object.keys(cards).find(function (k) { return cards[k].frame && cards[k].frame.contentWindow === e.source })
    if (!id) return
    var c = cards[id]
    if (m.type === 'ready') {
      c.ready = true
      c.outbox.splice(0).forEach(function (x) { c.frame.contentWindow.postMessage(x, '*') })
    } else if (m.type === 'height' && m.height > 80) {
      c.frame.style.height = Math.min(1400, m.height) + 'px'
    } else if (m.type === 'piece_error') {
      var w = c.waits['n' + m.n]; if (w) w.error = String(m.msg).slice(0, 600)
    } else if (m.type === 'ran') {
      var r = c.waits['n' + m.n]
      if (r) {
        delete c.waits['n' + m.n]
        var res = { ok: !r.error, error: r.error || undefined, kind: r.error ? 'code' : undefined }
        var brief = function (x) { return String(x).slice(0, 200) }
        if (m.overlaps && m.overlaps.length) res.overlaps = Array.prototype.slice.call(m.overlaps, 0, 6).map(brief)
        if (m.outside && m.outside.length) res.outside = Array.prototype.slice.call(m.outside, 0, 6).map(brief)
        r.done(res)
      }
    } else if (m.type === 'look' || m.type === 'cleared') {
      var l = c.waits[m.req]; if (l) { delete c.waits[m.req]; l.done(m.type === 'look' ? { ok: true, layout: m.result, png: m.png, error: m.error ? String(m.error).slice(0, 600) : undefined } : { ok: true }) }
    }
  })

  // Hermes's canvas tools, run in the card's sandboxed figure. Each resolves with the result for the tool.
  function canvasCall(id, make, timeoutMs) {
    var c = cards[id]
    if (!c) return Promise.resolve({ ok: false, error: 'There is no canvas ' + id + ' in the paper (closed or page reloaded).' })
    createFigure(c)
    return new Promise(function (resolve) {
      var key = make(c)
      c.waits[key.key] = { done: resolve, error: null }
      toFigure(c, key.msg)
      setTimeout(function () { if (c.waits[key.key]) { delete c.waits[key.key]; resolve({ ok: false, error: 'The canvas did not answer in time.' }) } }, timeoutMs)
    })
  }
  function runStep(id, code, after) {
    return canvasCall(id, function (c) {
      var n = c.n++
      if (c.statusText) { c.statusText.textContent = 'Hermes is drawing…' }
      reveal(c)
      return { key: 'n' + n, msg: { type: 'pieces', pieces: [{ n: n, code: String(code), after: after || null }] } }
    }, 25000).then(function (r) { var c = cards[id]; if (c) { c.statusText.textContent = ''; c.status.className = 'pa-status done' } return r })
  }
  function lookAt(id) {
    return canvasCall(id, function () { var req = 'look' + Math.random().toString(16).slice(2); return { key: req, msg: { type: 'look', req: req } } }, 15000)
  }
  function clearCanvas(id) {
    return canvasCall(id, function () { var req = 'clr' + Math.random().toString(16).slice(2); return { key: req, msg: { type: 'clear', req: req } } }, 8000)
  }

  // The whole paper as text (formulas as LaTeX), for Hermes's vellum_read tool.
  function paperText() {
    var root = (document.querySelector('.ltx_page_main') || document.querySelector('article') || document.body).cloneNode(true)
    root.querySelectorAll('.pa-card, script, style, nav, .ltx_page_footer, .ltx_bibliography').forEach(function (e) { e.remove() })
    root.querySelectorAll('h1, h2, h3, h4, h5, h6, .ltx_para, li, .ltx_caption, tr').forEach(function (e) { e.appendChild(document.createTextNode('\n\n')) })
    root.querySelectorAll('math').forEach(function (m) {
      var tex = m.getAttribute('alttext') || ''
      m.replaceWith(document.createTextNode(m.getAttribute('display') === 'block' ? ' $$' + tex + '$$ ' : ' $' + tex + '$ '))
    })
    var docTitle = document.querySelector('.ltx_title_document')
    var text = root.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*(\n\s*)+/g, '\n\n').trim()
    return { url: location.href.split('#')[0], title: docTitle ? clean(docTitle.textContent) : document.title, text: text }
  }

  function openFigure(id) {
    var c = cards[id]
    if (c) createFigure(c)
    return !!c
  }


  function hideButton() {
    if (btn) btn.style.display = 'none'
    pending = null
  }

  // Two ways in from a highlight: ✨ Visualize (just show me) and 💬 Ask (my own question, typed or spoken).
  function pill(label, kind) {
    var b = document.createElement('button')
    b.textContent = label
    b.className = 'pa-btn ' + (kind || '')
    // Cancel the mousedown so clicking does not clear the user's highlight before we read it.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation() })
    return b
  }

  function take() {
    var found = pending
    hideButton()
    if (!found) return null
    var cardId = createCard(found)
    window.getSelection().removeAllRanges()  // the card now stands for the passage; drop the blue highlight
    return { found: found, cardId: cardId }
  }

  function selectionOf(found) {
    return { text: found.text, url: found.url, paperTitle: found.paperTitle, section: found.section }
  }

  function showButton(found) {
    ensureStyle()
    if (!btn) {
      btn = document.createElement('div')
      var s = btn.style
      s.position = 'absolute'; s.zIndex = '2147483647'; s.display = 'none'; s.gap = '10px'
      btn.className = 'pa-bar'
      var mist = document.createElement('div')
      mist.className = 'pa-mist'
      btn.appendChild(mist)
      var vis = pill('Visualize')
      var ask = pill('Ask', 'ask')
      // Only a real click by the user sends anything to Hermes (a page script's synthetic click is ignored).
      vis.addEventListener('click', function (e) {
        e.preventDefault()
        if (!e.isTrusted) return
        var t = take()
        if (t) deliver({ type: 'visualize', cardId: t.cardId, selection: selectionOf(t.found) })
      })
      ask.addEventListener('click', function (e) {
        e.preventDefault()
        if (!e.isTrusted) return
        var t = take()
        if (!t) return
        var c = cards[t.cardId]
        if (c) c.statusText.textContent = 'Ask in the Hermes chat (type or speak)…'
        deliver({ type: 'askOpen', cardId: t.cardId, selection: selectionOf(t.found) })
      })
      btn.appendChild(vis)
      btn.appendChild(ask)
      document.body.appendChild(btn)
    }
    pending = found
    btn.style.display = 'flex'
    // Centered under the last highlighted line (at the selection's horizontal middle), kept inside the visible window.
    var margin = 12
    var w = btn.offsetWidth
    var h = btn.offsetHeight
    var x = found.box.left + found.box.width / 2 - w / 2
    x = Math.max(margin, Math.min(x, window.innerWidth - w - margin))
    var y = found.lastLine.bottom + 8
    if (y + h > window.innerHeight - margin) y = Math.max(margin, found.lastLine.top - h - 8)
    btn.style.left = (x + window.scrollX) + 'px'
    btn.style.top = (y + window.scrollY) + 'px'
  }

  function onMouseUp(e) {
    if (btn && btn.contains(e.target)) return
    setTimeout(function () {
      var found = capture()
      if (found) showButton(found); else hideButton()
    }, 10)
  }

  function onMouseDown(e) {
    if (btn && !btn.contains(e.target)) hideButton()
  }

  var api = {
    install: function () {
      // arXiv's own HTML papers, and ar5iv (arXiv's HTML for papers its own converter doesn't cover): same format
      var host = location.hostname
      if ((host !== 'arxiv.org' && host !== 'ar5iv.labs.arxiv.org' && host !== 'ar5iv.org') || location.pathname.indexOf('/html/') !== 0) {
        return { ok: false, reason: 'Open an arXiv paper in its HTML version first (arxiv.org/html/… or ar5iv).' }
      }
      document.addEventListener('mouseup', onMouseUp, true)
      document.addEventListener('mousedown', onMouseDown, true)
      return { ok: true, title: document.title }
    },
    // Long-poll: resolves on the next in-page event, or after 20 s with nothing so the plugin can ask again.
    wait: function () {
      if (queue.length) return Promise.resolve(queue.shift())
      return new Promise(function (resolve) {
        waiter = resolve
        setTimeout(function () { if (waiter === resolve) { waiter = null; resolve({ type: 'idle' }) } }, 20000)
      })
    },
    hasRuntime: function () { return !!runtimeHtml },
    runStep: runStep,
    lookAt: lookAt,
    clearCanvas: clearCanvas,
    paperText: paperText,
    hasCard: function (id) { return !!cards[id] },
    playVoice: function (id, item) { var c = cards[id]; if (!c) return false; createFigure(c); toFigure(c, Object.assign({ type: 'voice' }, item)); return true },
    setStatus: function (id, text) { var c = cards[id]; if (c) { c.statusText.textContent = text; c.status.className = 'pa-status' + (text ? '' : ' done') } return true },
    setRuntime: function (html) { runtimeHtml = html; return true },
    openFigure: openFigure,
    setLive: setLive,
    teardown: function () {
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      if (btn) btn.remove()
      btn = null
      Object.keys(cards).forEach(function (id) { cards[id].card.remove(); markSource(cards[id], false) })
      cards = {}
      liveId = null
      if (glowWatch) glowWatch.disconnect()
      var st = document.getElementById('pa-style'); if (st) st.remove()
      if (waiter) { var w = waiter; waiter = null; w({ type: 'end' }) }
    }
  }
  return Object.freeze({
    call: function (given, name, args) {
      if (given !== secret || !Object.prototype.hasOwnProperty.call(api, name)) return null
      return api[name].apply(null, args || [])
    }
  })
}

// The in-page script is installed under a fresh name each time, as a frozen, read-only window property. Page
// scripts can list window's properties and find it, so the name hides nothing: what keeps them from using it is the
// secret each call must carry, made here and never stored on the page. The property is only defined once the page
// is known to be an arXiv paper. Built by concatenation, so nothing is interpolated.
const random = n => {
  const a = new Uint32Array(n)
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(a)
  else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 4294967296)
  return Array.from(a, x => x.toString(36)).join('')
}
const newKey = () => ({ name: '__vellum_' + random(2), secret: random(6) })
const installCode = key =>
  '(function(){var api=(' + vellumInPage.toString() + ')(' + JSON.stringify(key.secret) + ');' +
  'var res=api.call(' + JSON.stringify(key.secret) + ',"install",[]);' +
  'if(res&&res.ok)Object.defineProperty(window,' + JSON.stringify(key.name) + ',{value:api,writable:false,configurable:false,enumerable:false});' +
  'return res;})()'
const callCode = (key, fn, args, otherwise) => {
  const at = 'window[' + JSON.stringify(key.name) + ']'
  return '(' + at + ' ? ' + at + '.call(' + JSON.stringify(key.secret) + ',' + JSON.stringify(fn) + ',' + JSON.stringify(args) + ') : ' + otherwise + ')'
}

const errText = err => (err && err.message) || String(err)
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

const $armed = atom(false)

function Chip({ toggle }) {
  const armed = useValue($armed)
  return jsx('button', {
    type: 'button',
    onClick: toggle,
    title: armed ? 'Hermes can draw in this paper. Click to stop.' : 'Let Hermes draw in the open arXiv paper',
    className: 'px-1.5 text-[0.6875rem] ' + (armed ? 'text-(--ui-text-primary)' : 'text-(--ui-text-tertiary)'),
    children: armed ? '✨ Vellum: on' : '✨ Vellum: off'
  })
}

// Prototype (branch vellum-pane-prototype): the figure can live in a Vellum pane beside the chat instead of in the
// paper. The pane hosts the same sandboxed figure runtime through the SDK's SandboxedFrame (opaque origin, no
// same-origin), loaded as a data: URL so the runtime keeps its own CSP. Voice and captions already live in the runtime.
const $paneMode = atom(false)  // draw in the pane instead of the paper
const $paneSrc = atom('')      // the figure runtime as a data: URL ('' = no figure open)
const $paneKey = atom(0)       // bumped for each new figure, so its frame starts fresh
const $paneHeight = atom(560)
const $paneStatus = atom('')

const toDataUrl = html => {
  const bytes = new TextEncoder().encode(html)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return 'data:text/html;base64,' + btoa(s)
}

function PaneView({ onToggle, onFrame, onLoad }) {
  const mode = useValue($paneMode)
  const src = useValue($paneSrc)
  const k = useValue($paneKey)
  const height = useValue($paneHeight)
  const status = useValue($paneStatus)
  const header = jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', fontSize: '12px' },
    children: [
      jsx('span', { style: { fontWeight: 600, letterSpacing: '.08em' }, children: 'VELLUM CANVAS' }),
      jsx('span', { style: { flex: 1, opacity: 0.7 }, children: status }),
      jsx('button', {
        type: 'button',
        onClick: onToggle,
        title: mode ? 'Figures draw in this pane. Click to draw in the paper again.' : 'Draw figures in this pane instead of the paper',
        style: { padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(127,127,160,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
        children: mode ? 'Drawing here: on' : 'Drawing here: off'
      })
    ]
  })
  const body = src
    ? jsx(SandboxedFrame, {
        key: 'fig' + k,
        title: 'Live figure',
        src,
        ref: onFrame,
        onLoad,
        style: { width: '100%', height: height + 'px', border: 0, display: 'block', background: '#19192F', borderRadius: '4px' }
      })
    : jsx('div', {
        style: { opacity: 0.6, fontSize: '13px', lineHeight: 1.5, padding: '24px 4px' },
        children: mode
          ? 'Highlight a passage in the paper and click Visualize: the figure draws here while Hermes talks.'
          : 'Turn on "Drawing here" to draw figures in this pane instead of inside the paper.'
      })
  return jsxs('div', { style: { height: '100%', overflow: 'auto', padding: '12px' }, children: [header, body] })
}

export default {
  id: 'vellum',
  name: 'Vellum',
  capabilities: ['preview.executeJavaScript'],
  register(ctx) {
    // A fresh load (plugin toggled, app reloaded) starts switched off: the chip must never claim "on" for a
    // page this instance hasn't set up.
    $armed.set(false)
    let generation = 0
    let runtime = null // the sandboxed figure runtime page, fetched once from the backend
    let key = newKey()  // where this instance's in-page script lives (renewed on every install)
    let liveCard = ''   // the figure the chat is talking to (LIVE), mirrored to /state
    const page = code => ctx.preview.executeJavaScript(code)
    const call = (fn, ...args) => page(callCode(key, fn, args, 'null'))
    const install = () => { key = newKey(); return page(installCode(key)) }
    const postState = () => ctx.rest('/state', { method: 'POST', body: { armed: $armed.get(), live: liveCard }, timeoutMs: 10000 }).catch(() => {})

    async function ensureRuntime() {
      if (!runtime) runtime = (await ctx.rest('/runtime', { timeoutMs: 30000 })).html
      if (!(await call('hasRuntime'))) await call('setRuntime', runtime)
    }

    // ---- The Vellum pane (prototype): the same figure protocol as the in-page card, with the frame in Desktop ----
    const pane = { canvas: '', frame: null, ready: false, outbox: [], waits: {}, n: 0, loads: 0 }
    $paneMode.set(!!ctx.storage.get('paneMode', false))
    const togglePane = () => { const on = !$paneMode.get(); $paneMode.set(on); ctx.storage.set('paneMode', on) }
    const failPane = error => {
      Object.keys(pane.waits).forEach(k => { const w = pane.waits[k]; delete pane.waits[k]; w.done({ ok: false, error }) })
      pane.ready = false
    }
    const toPane = msg => {
      if (pane.ready && pane.frame && pane.frame.contentWindow) pane.frame.contentWindow.postMessage(msg, '*')
      else pane.outbox.push(msg)
    }
    // srcdoc-like rule: the runtime loads exactly once; any later load is the figure navigating itself, so stop it.
    const onPaneLoad = () => {
      if (++pane.loads < 2) return
      failPane('The figure tried to leave its frame and was stopped. Figures can only draw.')
      $paneSrc.set('')
      $paneStatus.set('Figure stopped')
    }
    const onPaneFrame = el => { pane.frame = el || null }
    const paneOpen = async cardId => {
      failPane('A new figure was opened.')
      Object.assign(pane, { canvas: cardId, frame: null, ready: false, outbox: [], waits: {}, n: 0, loads: 0 })
      if (!runtime) runtime = (await ctx.rest('/runtime', { timeoutMs: 30000 })).html
      $paneHeight.set(560)
      $paneStatus.set('Ready: press Enter in your Hermes chat')
      $paneKey.set($paneKey.get() + 1)
      $paneSrc.set(toDataUrl(runtime))
    }
    const paneCall = (make, timeoutMs) => {
      if (!pane.canvas || !$paneSrc.get()) return Promise.resolve({ ok: false, error: 'The Vellum pane has no figure open.' })
      return new Promise(resolve => {
        const k = make()
        pane.waits[k.key] = { done: resolve, error: null }
        toPane(k.msg)
        ctx.setTimeout(() => { if (pane.waits[k.key]) { delete pane.waits[k.key]; resolve({ ok: false, error: 'The canvas did not answer in time.' }) } }, timeoutMs)
      })
    }
    const reqId = p => p + Math.random().toString(16).slice(2)
    const paneRunStep = (code, after) => {
      $paneStatus.set('Hermes is drawing…')
      return paneCall(() => { const n = pane.n++; return { key: 'n' + n, msg: { type: 'pieces', pieces: [{ n, code: String(code), after: after || null }] } } }, 25000)
        .then(r => { $paneStatus.set(''); return r })
    }
    const paneLook = () => paneCall(() => { const req = reqId('look'); return { key: req, msg: { type: 'look', req } } }, 15000)
    const paneClear = () => paneCall(() => { const req = reqId('clr'); return { key: req, msg: { type: 'clear', req } } }, 8000)
    // Only messages from the pane's own figure frame count; everything it reports is rebuilt from known fields.
    ctx.addEventListener(window, 'message', e => {
      const m = e.data
      if (!m || !m.pa || !pane.frame || e.source !== pane.frame.contentWindow) return
      if (m.type === 'ready') {
        pane.ready = true
        pane.outbox.splice(0).forEach(x => pane.frame.contentWindow.postMessage(x, '*'))
      } else if (m.type === 'height' && m.height > 80) {
        $paneHeight.set(Math.min(1400, Number(m.height) || 560))
      } else if (m.type === 'piece_error') {
        const w = pane.waits['n' + m.n]; if (w) w.error = String(m.msg).slice(0, 600)
      } else if (m.type === 'ran') {
        const r = pane.waits['n' + m.n]
        if (!r) return
        delete pane.waits['n' + m.n]
        const brief = x => String(x).slice(0, 200)
        const res = { ok: !r.error, error: r.error || undefined, kind: r.error ? 'code' : undefined }
        if (Array.isArray(m.overlaps) && m.overlaps.length) res.overlaps = m.overlaps.slice(0, 6).map(brief)
        if (Array.isArray(m.outside) && m.outside.length) res.outside = m.outside.slice(0, 6).map(brief)
        r.done(res)
      } else if (m.type === 'look' || m.type === 'cleared') {
        const l = pane.waits[m.req]
        if (!l) return
        delete pane.waits[m.req]
        l.done(m.type === 'look' ? { ok: true, layout: m.result, png: m.png, error: m.error ? String(m.error).slice(0, 600) : undefined } : { ok: true })
      }
    })

    // The paper's full text goes to the backend once per page. On the first highlight our hook hands it (and the
    // drawing skill) to Hermes quietly, inside that turn: nothing extra appears in the chat (paper_anim/turns.py).
    async function sharePaper() {
      const p = await call('paperText')
      if (p && p.text) await ctx.rest('/paper', { method: 'POST', body: p, timeoutMs: 30000 })
    }

    // Which card the chat is talking to (LIVE); none = Hermes chats normally. The hooks read it from /state.
    const setLive = (cardId) => {
      liveCard = cardId || ''
      postState()
      call('setLive', cardId || null).catch(() => {})
    }

    // Nothing here sends a chat message: a click in the page only puts a draft into the user's Hermes chat box, and
    // the user sends it with Enter. A web page (or a script in it) can therefore never start a turn by itself.
    async function toDraft(text) {
      let ok = false
      try { ok = await host.composer.insertText(null, text, { mode: 'block' }) } catch (err) { ok = false }
      if (ok) host.composer.focus(null)
      return ok
    }

    // Everything from the page is checked before it reaches the chat: a card id, an arXiv paper, bounded text.
    const CARD = /^pa-[a-z0-9]{1,30}$/
    const PAPER = /^https:\/\/(arxiv\.org|ar5iv\.labs\.arxiv\.org|ar5iv\.org)\/html\/[^)\s#`]{1,160}$/
    const paperUrl = sel => String(sel.url || '').split('#')[0]
    const validEvent = ev => !!ev && typeof ev === 'object' && (!('cardId' in ev) || CARD.test(String(ev.cardId))) &&
      (!ev.selection || (typeof ev.selection.text === 'string' && ev.selection.text.length >= 15 &&
        PAPER.test(paperUrl(ev.selection))))
    // A draft's first line holds only what the plugin made itself: the checked paper URL and the card id (the agent
    // half reads the paper and the canvas from that line alone). The title and the section name are page text, so
    // they go into the quote with the passage, as its first line.
    const defuse = s => String(s).replace(/[\u200b-\u200d\u2060\ufeff]/g, ' ').replace(/\[(?=\s*vellum)/gi, '(').replace(/={3,}/g, m => '-'.repeat(m.length))
    const draft = (lead, cardId, sel, n) => {
      const source = defuse([short(sel.paperTitle, 90), short(sel.section, 60)].filter(Boolean).join(' · ').replace(/`/g, "'"))
      const lines = (source ? ['📄 ' + source] : []).concat(defuse(String(sel.text).slice(0, n)).split('\n'))
      return { head: lead + ' this passage from the paper (' + paperUrl(sel) + ') on canvas `' + cardId + '`:', quote: lines.map(l => '> ' + l).join('\n') }
    }

    // The chat a click belongs to (both of Desktop's ids for it; a brand-new chat may have none yet).
    const chatIds = () => {
      try { return [host.state.focusedStoredSessionId.get(), host.state.focusedSessionId.get()].filter(Boolean) } catch (err) { return [] }
    }
    // The card the user just opened is registered with our backend before its draft exists: the agent half starts a
    // paper turn only for a registered card, never for a message that merely looks like one of our drafts.
    const registerCard = (cardId, sel, sessions) =>
      ctx.rest('/card', { method: 'POST', body: { id: cardId, url: paperUrl(sel), sessions }, timeoutMs: 10000 })

    const visualize = async (cardId, sel) => {
      const inPane = $paneMode.get()
      try {
        await registerCard(cardId, sel, chatIds())
        if (inPane) await paneOpen(cardId)
        else { await ensureRuntime(); await call('openFigure', cardId) }
      } catch (err) {
        call('setStatus', cardId, 'Could not start: ' + errText(err))
        return
      }
      const { head, quote } = draft('✨ Visualize', cardId, sel, 3000)
      setLive(cardId)
      const ok = await toDraft(head + '\n\n' + quote)
      call('setStatus', cardId, !ok ? 'Open a Hermes chat first'
        : inPane ? 'Press Enter in your Hermes chat: the figure draws in the Vellum pane' : 'Ready in your Hermes chat: press Enter to send')
      if (!ok) host.notify({ kind: 'warning', message: 'Open a Hermes chat next to the paper, then try again.' })
    }

    // 💬 Ask, Annotate-style: the passage goes into the Hermes chat as a draft; the user adds their question (typed or
    // dictated) and sends it. A question spoken in a voice conversation within two minutes is bound to it too.
    const askDraft = async (cardId, sel) => {
      // The chat this Ask belongs to, so a question spoken in another chat is never bound to it.
      const sessions = chatIds()
      try { await registerCard(cardId, sel, sessions) } catch (err) {
        host.notify({ kind: 'warning', message: 'Vellum could not reach Hermes: ' + errText(err) })
        return
      }
      setLive(cardId)
      ctx.rest('/selection', { method: 'POST', body: { id: cardId, ask: true, sessions, ...sel, url: paperUrl(sel) }, timeoutMs: 10000 }).catch(() => {})
      try {
        if ($paneMode.get()) await paneOpen(cardId)
        else { await ensureRuntime(); await call('openFigure', cardId) }
      } catch (err) { /* the figure opens on the first stroke anyway */ }
      const { head, quote } = draft('💬 Ask about', cardId, sel, 1500)
      const ok = await toDraft(head + '\n' + quote + '\n\nMy question: ')
      if (!ok) host.notify({ kind: 'info', message: 'Open a Hermes chat next to the paper, or just ask out loud in a voice conversation.' })
    }

    // Hermes's canvas tools arrive as plugin events; run them in the paper and report back to the waiting tool.
    const answer = (req, result) => ctx.rest('/canvas/result', { method: 'POST', body: { req, result }, timeoutMs: 30000 }).catch(() => {})
    const onCanvas = (fn, timeoutMs) => async ({ payload }) => {
      const p = payload || {}
      // Off in this window: stay quiet (another window may have the paper; the tool fails fast when none is on).
      if (!p.req || !$armed.get()) return
      // This figure lives in the Vellum pane: run the step there.
      if ($paneMode.get() && p.canvas && p.canvas === pane.canvas) {
        const run = fn === 'runStep' ? paneRunStep(p.code, p.after) : fn === 'lookAt' ? paneLook() : paneClear()
        answer(p.req, await run.catch(err => ({ ok: false, error: errText(err) })))
        return
      }
      try {
        // Not this window's card: let the window that has it answer (its piece may wait ~10 s for the voice);
        // only then report "no such canvas", for the case where the card is really gone.
        if (!(await call('hasCard', p.canvas))) await new Promise(resolve => ctx.setTimeout(resolve, 12000))
        if (fn === 'runStep') await ensureRuntime()
        const result = await Promise.race([
          fn === 'runStep' ? call('runStep', p.canvas, p.code, p.after || null) : call(fn, p.canvas),
          new Promise(resolve => ctx.setTimeout(() => resolve({ ok: false, error: 'The paper did not answer.' }), timeoutMs))
        ])
        answer(p.req, result || { ok: false, error: 'Vellum is not running in the open page.' })
      } catch (err) {
        answer(p.req, { ok: false, error: errText(err) })
      }
    }
    host.onEvent('plugin.vellum.canvas.draw', onCanvas('runStep', 28000))
    host.onEvent('plugin.vellum.canvas.look', onCanvas('lookAt', 18000))
    host.onEvent('plugin.vellum.canvas.clear', onCanvas('clearCanvas', 9000))
    // The user sent the draft and Hermes started on it (paper_anim/turns.py): say so on the card.
    host.onEvent('plugin.vellum.turn', ({ payload }) => {
      const p = payload || {}
      if (!p.canvas || !$armed.get() || !CARD.test(String(p.canvas))) return
      if ($paneMode.get() && p.canvas === pane.canvas) $paneStatus.set('Hermes is looking at it…')
      else call('setStatus', p.canvas, 'Hermes is looking at it…').catch(() => {})
    })
    // Hermes's voice for our turns: each sentence is voiced as it streams (paper_anim/turns.py) and played in the card.
    host.onEvent('plugin.vellum.voice', async ({ payload }) => {
      const p = payload || {}
      if (!p.canvas || !$armed.get() || !CARD.test(String(p.canvas))) return
      const inPane = $paneMode.get() && p.canvas === pane.canvas
      const play = item => (inPane ? Promise.resolve(toPane(Object.assign({ type: 'voice' }, item))) : call('playVoice', p.canvas, item))
      if (p.failed) { play({ turn: p.turn, seq: p.seq, text: p.text, failed: true }).catch(() => {}); return }
      if (!p.file) return
      try {
        const { src } = await ctx.rest('/voice/' + encodeURIComponent(p.file), { timeoutMs: 15000 })
        await play({ turn: p.turn, seq: p.seq, text: p.text, src })
      } catch (err) { /* a sentence that can't be fetched is just not heard */ }
    })

    const PAGE_WAIT_MS = 25000
    const loop = async gen => {
      let beat = 0
      while ($armed.get() && gen === generation) {
        // Re-confirm "on" every ~20 s, so the hooks and tools see a closed or crashed Desktop as off.
        if (Date.now() - beat > 15000) { beat = Date.now(); postState() }
        // The page answers every wait within 20 s (with 'idle' when nothing happened). No answer means it navigated or
        // closed mid-wait: Desktop then never settles the call (0.22.x) or cancels it (0.23.x).
        let ev
        try {
          ev = await Promise.race([
            page(callCode(key, 'wait', [], 'Promise.resolve({ type: "gone" })')),
            new Promise(resolve => ctx.setTimeout(() => resolve(null), PAGE_WAIT_MS))
          ])
        } catch (err) {
          ev = null
        }
        if (gen !== generation) return
        if (ev === null) {
          // Pause without running anything in what is there now (Desktop would ask for permission on a new site); one
          // click on the chip turns Vellum back on for the next paper.
          stop({ leavePage: true })
          host.notify({ kind: 'info', message: 'Vellum paused: the page changed. Click ✨ Vellum to turn it on for this paper.' })
          return
        }
        if (!validEvent(ev)) continue
        if (ev.type === 'gone') {
          // Same-site navigation (a new paper, a reload) wiped the page script and its cards: put it back.
          if (liveCard) setLive(null)
          const res = await install().catch(() => null)
          if (!res || !res.ok) { stop({ leavePage: true }); host.notify({ kind: 'info', message: 'Vellum paused: ' + ((res && res.reason) || 'page changed') }); return }
          sharePaper().catch(() => {})
        } else if (ev && ev.type === 'visualize') {
          visualize(ev.cardId, ev.selection)
        } else if (ev && ev.type === 'askOpen') {
          askDraft(ev.cardId, ev.selection)
        } else if (ev && ev.type === 'live') {
          setLive(ev.on ? ev.cardId : null)
          if (!ev.on) host.notify({ kind: 'info', message: 'Left the paper. Hermes chats normally again (click Resume on the figure to go back).' })
        } else if (ev && ev.type === 'close' && ev.wasLive) {
          setLive(null)
        }
      }
    }

    const start = async () => {
      if (!ctx.preview.isAvailable()) {
        host.notify({ kind: 'info', message: 'Open an arXiv paper (its HTML version) in the Browser first.' })
        return
      }
      try {
        const res = await install()
        if (!res || !res.ok) { host.notify({ kind: 'info', message: (res && res.reason) || 'Could not start here.' }); return }
        generation += 1
        $armed.set(true)
        host.notify({ kind: 'info', message: 'Vellum is on. Highlight a passage, then click Visualize or Ask.' })
        liveCard = ''
        postState()
        loop(generation)
        sharePaper().catch(err => host.notifyError(err, 'Could not share the paper with Hermes'))
      } catch (err) {
        host.notifyError(err, 'Could not start Vellum')
      }
    }

    function stop({ leavePage = false } = {}) {
      generation += 1
      $armed.set(false)
      liveCard = ''
      postState()
      if (!leavePage) call('teardown').catch(() => {})
    }

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 125,
      render: () => jsx(Chip, { toggle: () => ($armed.get() ? stop() : start()) })
    })
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Vellum',
      data: { placement: 'right', width: '560px', minWidth: '380px', maxWidth: '1100px' },
      render: () => jsx(PaneView, { onToggle: togglePane, onFrame: onPaneFrame, onLoad: onPaneLoad })
    })
    ctx.onDispose(() => { if ($armed.get()) stop() })
  }
}
