// Live figure runtime. Runs ONLY inside a sandboxed iframe (sandbox="allow-scripts", opaque origin,
// CSP default-src 'none'): no network, no access to the paper page or to Hermes. It receives the
// model-written figure program piece by piece over postMessage and runs each piece as it arrives.
//
// Pieces share one scope: top-level const/let/function/class names are rewritten (with acorn) into
// assignments on a shared object S, and each piece runs inside `with (S)`, so later pieces and
// follow-up turns can use earlier names directly. A failing piece is reported and skipped.
(function () {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const S = Object.create(null);
  const stage = document.getElementById('stage');
  const cap = document.getElementById('cap');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const post = msg => parent.postMessage(Object.assign({ pa: true }, msg), '*');
  let busy = false;

  // ---- fit the 960x540 stage to the card width ----
  function fit() {
    const k = Math.min(1, window.innerWidth / 960);
    document.getElementById('scaler').style.transform = `scale(${k})`;
    document.getElementById('frame').style.height = Math.ceil(540 * k) + 'px';  // the scaled stage's real footprint
    const h = Math.ceil(540 * k + document.getElementById('below').offsetHeight + 8);
    post({ type: 'height', height: h });
  }
  window.addEventListener('resize', fit);

  // ---- what the figure program can call (besides d3 and the stage) ----
  // A formula is a foreignObject holding KaTeX's HTML. It remembers what it shows, so if figure code ever pulls its
  // insides apart (e.g. moving every element on the board into a group), repairMath() puts it back together.
  function renderMath(fo) {
    const { latex, size, color, anchor, x, y } = fo.__paMath;
    fo.replaceChildren();
    const div = document.createElement('div');
    div.className = 'math';
    Object.assign(div.style, { fontSize: size + 'px', color, display: 'inline-block' });
    katex.render(String(latex), div, { throwOnError: false, displayMode: false });
    for (const el of [div, ...div.querySelectorAll('*')]) el.setAttribute('data-pa-part', '');
    fo.appendChild(div);
    // Measure now, and again once KaTeX's fonts have loaded (they change the width), so nothing is clipped.
    const place = () => {
      if (div.parentNode !== fo) return;
      const w = div.offsetWidth, h = div.offsetHeight;
      fo.setAttribute('width', w + 6); fo.setAttribute('height', h + 6);
      fo.setAttribute('x', anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2);
      fo.setAttribute('y', y - h / 2);
    };
    place();
    if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(place);
  }
  function math(parent, latex, x, y, opts = {}) {
    const { size = 26, color = '#ECECEC', anchor = 'middle', id } = opts;
    if (parent && typeof parent.node === 'function') parent = parent.node();
    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('width', 900); fo.setAttribute('height', 200);
    fo.setAttribute('overflow', 'visible');
    fo.setAttribute('data-pa-math', '');
    if (id) fo.id = id;
    fo.__paMath = { latex, size, color, anchor, x, y };
    parent.appendChild(fo);
    renderMath(fo);
    return fo;
  }
  function repairMath() {
    let fixed = 0;
    // pieces of a formula that ended up outside it: drop them (they'd draw as stray, often giant, glyphs)
    for (const el of stage.querySelectorAll('[data-pa-part]')) {
      const home = el.closest('foreignObject[data-pa-math]');
      if (!home && el.isConnected) { el.remove(); fixed++; }
    }
    // formulas that lost their insides: draw them again, in place
    for (const fo of stage.querySelectorAll('foreignObject[data-pa-math]')) {
      const div = fo.firstElementChild;
      if (fo.__paMath && (!div || !div.classList.contains('math') || !div.querySelector('.katex'))) { renderMath(fo); fixed++; }
    }
    return fixed;
  }
  const safely = fn => { try { return fn(); } catch (e) { return undefined; } };

  // ---- running pieces in one shared scope ----
  function names(pattern, out) {
    if (!pattern) return out;
    if (pattern.type === 'Identifier') out.push(pattern.name);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(p => names(p.type === 'RestElement' ? p.argument : p.value, out));
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(e => names(e && e.type === 'RestElement' ? e.argument : e, out));
    else if (pattern.type === 'AssignmentPattern') names(pattern.left, out);
    return out;
  }

  // Figures only draw. Refuse the obvious ways out of the frame (the CSP already blocks every network request;
  // the paper page also removes a figure that navigates away). Best effort: it explains the rule to the model.
  const BLOCKED_PROPS = new Set(['location', 'opener', 'postMessage', 'cookie', 'domain']);
  const BLOCKED_NAMES = new Set(['location', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']);
  function guard(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'MemberExpression' && !node.computed && BLOCKED_PROPS.has(node.property.name))
      throw new Error(`"${node.property.name}" is not available: figures can only draw.`);
    if (node.type === 'Identifier' && BLOCKED_NAMES.has(node.name) && node._ref)
      throw new Error(`"${node.name}" is not available: figures can only draw.`);
    for (const k in node) {
      if (k === '_ref') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(x => { if (x && typeof x.type === 'string') { mark(node, k, x); guard(x); } });
      else if (v && typeof v.type === 'string') { mark(node, k, v); guard(v); }
    }
  }
  // An identifier is a reference (not a property key or a name being declared) in these positions.
  function mark(parent, key, child) {
    if (child.type !== 'Identifier') return;
    const decl = (parent.type === 'VariableDeclarator' && key === 'id') || ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && (key === 'id' || key === 'params'));
    const prop = (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key' && !parent.computed);
    child._ref = !decl && !prop;
  }

  function rewrite(code) {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
    guard(ast);
    const edits = [], declared = [];
    for (const node of ast.body) {
      if (node.type === 'VariableDeclaration') {
        node.declarations.forEach(d => names(d.id, declared));
        // the leading ';' keeps a previous line without a semicolon from swallowing the '(' as a call
        edits.push({ start: node.start, end: node.end, text: ';(' + node.declarations.map(d => code.slice(d.start, d.end)).join(', ') + ');' });
      } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
        declared.push(node.id.name);
        edits.push({ start: node.start, end: node.start, text: ';' + node.id.name + ' = ' });
        edits.push({ start: node.end, end: node.end, text: ';' });
      }
    }
    let out = code;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return { code: out, declared };
  }

  // Safety net: after each step, nudge labels and formulas that ended up past the stage edge back inside.
  function nudgeInside() {
    const R = stage.getBoundingClientRect();
    const k = R.width / 960 || 1;
    for (const el of stage.querySelectorAll('svg text, svg foreignObject')) {
      if (el.closest('defs')) continue;
      const box = (el.tagName === 'foreignObject' ? el.firstElementChild : el)?.getBoundingClientRect();
      if (!box || box.width < 1) continue;
      let dx = 0, dy = 0;
      if (box.left < R.left + 6) dx = (R.left + 6 - box.left) / k; else if (box.right > R.right - 6) dx = (R.right - 6 - box.right) / k;
      if (box.top < R.top + 4) dy = (R.top + 4 - box.top) / k; else if (box.bottom > R.bottom - 4) dy = (R.bottom - 4 - box.bottom) / k;
      if (dx || dy) {
        const attrX = el.tagName === 'foreignObject' ? 'x' : (el.hasAttribute('x') ? 'x' : null);
        if (attrX && !String(el.getAttribute('x')).includes(' ')) {
          el.setAttribute('x', +el.getAttribute('x') + dx);
          el.setAttribute('y', +(el.getAttribute('y') || 0) + dy);
        }
      }
    }
  }

  // Labels stay on top: a line drawn after a label would strike it through. Moving each label (and formula) to the
  // end of its own group changes only the stacking order; the nodes, and any d3 handle on them, stay the same.
  function raiseLabels() {
    for (const el of stage.querySelectorAll('svg text, svg foreignObject')) {
      if (el.closest('defs') || !el.parentNode || el.parentNode.lastElementChild === el) continue;
      el.parentNode.appendChild(el);
    }
  }

  // Voice-drawing sync: a piece waits until Hermes's voice has started the sentence it belongs to (at most `ms`,
  // so a slow or failed voice never freezes the drawing).
  async function voiceReaches(after, ms) {
    const end = Date.now() + ms;
    const reached = () => voice.done.has(after.turn) ||
      (voice.turn === after.turn && (voice.next > after.seq || (voice.next === after.seq && !!voice.playing)));
    while (!reached() && Date.now() < end) await sleep(80);
  }

  const queue = [];
  const STEP_MS = 8000;  // the longest one drawing step may run
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const piece = queue.shift();
      // Every step always reports back, whatever its code does: a figure never freezes.
      let lay = { overlaps: [], outside: [] };
      try {
        if (piece.after) await voiceReaches(piece.after, 10000);  // shown when Hermes starts talking about it
        document.getElementById('thinking')?.remove();
        const before = new Set(stage.querySelectorAll('*'));
        const added = [];
        const watch = new MutationObserver(rs => rs.forEach(r => r.addedNodes.forEach(n => { if (n.nodeType === 1) added.push(n); })));
        watch.observe(stage, { childList: true, subtree: true });
        let error = null;
        try {
          const r = rewrite(piece.code);
          r.declared.forEach(n => { if (!(n in S)) S[n] = undefined; });
          const fn = new AsyncFunction('S', 'stage', 'math', 'd3',
            'with (S) { return (async () => {\n' + r.code + '\n})(); }');
          await Promise.race([fn(S, stage, math, window.d3),
            sleep(STEP_MS).then(() => { throw new Error(`this step took longer than ${STEP_MS / 1000} s and was stopped`); })]);
        } catch (e) {
          error = String(e && e.message || e).slice(0, 200);
        }
        watch.takeRecords().forEach(r => r.addedNodes.forEach(n => { if (n.nodeType === 1) added.push(n); }));
        watch.disconnect();
        if (error) {  // a failed step leaves nothing half-drawn behind: what it added (and holds nothing older) goes
          for (const n of added) {
            if (n.isConnected && !before.has(n) && ![...n.querySelectorAll('*')].some(d => before.has(d))) n.remove();
          }
          post({ type: 'piece_error', n: piece.n, msg: error + ' (nothing from this step was kept)' });
        }
        safely(repairMath);
        safely(raiseLabels);
        setTimeout(() => { safely(repairMath); safely(nudgeInside); safely(raiseLabels); }, 900);  // after its animations
        lay = safely(layoutCheck) || lay;  // labels that overlap or are cut off, so they get fixed in the next step
      } finally {
        post({ type: 'ran', n: piece.n, overlaps: (lay.overlaps || []).slice(0, 6), outside: (lay.outside || []).slice(0, 6) });
      }
    }
    busy = false;
  }

  // Layout self-check: after every drawing step, and for canvas_look: visible things outside the stage, overlapping labels.
  function layoutCheck() {
    const R = stage.getBoundingClientRect();
    const visible = el => { for (let n = el; n && n !== stage; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; } return true; };
    // formulas are measured as a whole: KaTeX's own invisible struts would read as false alarms
    const items = [...stage.querySelectorAll('svg *, input')].filter(el => !el.closest('foreignObject') || el.tagName === 'foreignObject')
      .filter(el => !['defs', 'marker', 'g', 'svg', 'linearGradient', 'radialGradient', 'stop', 'tspan', 'title', 'clipPath', 'filter', 'mask', 'pattern'].includes(el.tagName) && visible(el));
    const outside = [];
    for (const el of items) {
      const r = (el.tagName === 'foreignObject' && el.firstElementChild || el).getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      if (r.left < R.left - 2 || r.top < R.top - 2 || r.right > R.right + 2 || r.bottom > R.bottom + 2) outside.push(el.tagName + ':' + (el.textContent || '').trim().slice(0, 30));
    }
    const labels = items.filter(el => el.tagName === 'text' || el.tagName === 'foreignObject')
      .map(el => ({ t: (el.textContent || '').trim().slice(0, 25), r: (el.tagName === 'foreignObject' && el.firstElementChild || el).getBoundingClientRect() }))
      .filter(o => o.r.width > 2 && o.t);
    const overlaps = [];
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].r, b = labels[j].r;
      const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      // also catch slivers: text running into the next label on the same line
      if (ix * iy > 0.25 * Math.min(a.width * a.height, b.width * b.height) || (ix > 3 && iy > 0.5 * Math.min(a.height, b.height))) overlaps.push(labels[i].t + ' / ' + labels[j].t);
    }
    return { outside, overlaps, labels: labels.length };
  }

  // A picture of the canvas, for the agent to look at its own drawing: the stage is cloned with the page's styles
  // (KaTeX fonts are data URLs already) into an SVG foreignObject and rasterised, all inside the sandbox.
  async function snapshot() {
    const css = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n');
    const clone = stage.cloneNode(true);
    clone.querySelectorAll('input[type=range]').forEach((el, i) => el.setAttribute('value', stage.querySelectorAll('input[type=range]')[i].value));
    const xhtml = new XMLSerializer().serializeToString(clone);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><foreignObject width="960" height="540">' +
      '<div xmlns="http://www.w3.org/1999/xhtml"><style>' + css.replace(/]]>/g, '') + '</style>' + xhtml + '</div></foreignObject></svg>';
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 960; c.height = 540;
    const g = c.getContext('2d');
    g.fillStyle = '#14171C'; g.fillRect(0, 0, 960, 540);
    g.drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  }

  // Wiping the board: the old drawing fades and softens away instead of vanishing in one frame.
  async function clearCanvas() {
    d3.select(stage).selectAll('*').interrupt();
    const old = [...stage.children];
    old.forEach(el => { el.style.transition = 'opacity .9s ease, filter .9s ease, transform .9s ease'; el.style.transformOrigin = 'center'; });
    cap.style.opacity = 0;
    await sleep(20);
    old.forEach(el => { el.style.opacity = 0; el.style.filter = 'blur(6px)'; el.style.transform = 'scale(.97)'; });
    await sleep(920);
    old.forEach(el => el.remove());
    for (const k of Object.keys(S)) delete S[k];
    cap.textContent = ''; cap.style.opacity = 1;
    fit();
  }

  // The caption streams in with the voice: each letter arrives as a bright turquoise glow and settles into soft white,
  // paced so the line finishes a little before the sentence does.
  function streamCaption(text, seconds) {
    cap.textContent = ''; cap.style.opacity = 1;
    const n = Math.max(1, text.length);
    const step = Math.min(70, Math.max(16, (isFinite(seconds) && seconds > 0 ? seconds * 1000 * 0.8 : n * 45) / n));
    let i = 0;
    for (const word of text.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) { cap.appendChild(document.createTextNode(' ')); i++; continue; }
      const w = document.createElement('span'); w.className = 'w';
      for (const ch of word) {
        const c = document.createElement('span'); c.className = 'ch'; c.textContent = ch;
        c.style.animationDelay = Math.round(i++ * step) + 'ms';
        w.appendChild(c);
      }
      cap.appendChild(w);
    }
    fit();
  }

  // Hermes's voice: sentences arrive as they are voiced (possibly out of order); play them in order, one at a time.
  // A new turn restarts the count; a sentence that never arrives is skipped after a moment.
  const voice = { turn: null, next: 0, q: [], playing: null, timer: null, done: new Set() };
  function stopVoice() {
    if (voice.playing && voice.playing.pause) voice.playing.pause();
    voice.playing = null; clearTimeout(voice.timer); voice.timer = null; voice.q = [];
  }
  function onVoice(m) {
    if (m.turn !== voice.turn) {
      if (voice.done.has(m.turn)) return;            // a late sentence from a turn that's already over
      if (voice.turn) voice.done.add(voice.turn);
      stopVoice(); voice.turn = m.turn; voice.next = 0;
    }
    if (m.seq < voice.next) return;                  // already skipped
    voice.q.push({ seq: m.seq, text: m.text, src: m.src, failed: !!m.failed });
    playVoice();
  }
  function playVoice() {
    if (voice.playing) return;
    const i = voice.q.findIndex(v => v.seq === voice.next);
    if (i < 0) {  // the next sentence is late: after a while, skip ahead to the earliest one that did arrive
      if (voice.q.length && !voice.timer) voice.timer = setTimeout(() => {
        voice.timer = null;
        const later = voice.q.filter(v => v.seq > voice.next);
        if (later.length) voice.next = Math.min(...later.map(v => v.seq));
        playVoice();
      }, 8000);
      return;
    }
    clearTimeout(voice.timer); voice.timer = null;
    const v = voice.q.splice(i, 1)[0], turn = voice.turn;
    const done = () => { if (voice.turn !== turn) return; voice.playing = null; voice.next = Math.max(voice.next, v.seq + 1); playVoice(); };
    if (v.failed || !v.src) {  // not voiced: show it as a caption for about as long as it would take to say
      voice.playing = { pause() {} };
      streamCaption(v.text, v.text.split(/\s+/).length / 2.8);
      setTimeout(done, 1000 * v.text.split(/\s+/).length / 2.8);
      return;
    }
    const a = new Audio(v.src);
    voice.playing = a;
    let shown = false;
    const show = () => { if (!shown) { shown = true; streamCaption(v.text, a.duration); } };
    a.onplaying = show;
    a.onended = done; a.onerror = () => { show(); done(); };
    a.play().catch(() => { show(); done(); });
    setTimeout(show, 600);  // never leave a sentence without its caption
  }

  window.addEventListener('message', e => {
    if (e.source !== parent) return;  // only the paper page that hosts this figure talks to it
    const m = e.data || {};
    if (m.type === 'pieces') { queue.push(...m.pieces); pump(); }
    else if (m.type === 'voice' && (m.src || m.failed)) { onVoice(m); }
    else if (m.type === 'look') {
      // Look at the settled picture: after pending steps have run and their animations have finished.
      (async () => {
        const until = Date.now() + 8000;
        while ((busy || queue.length) && Date.now() < until) await sleep(80);
        await sleep(900);
        const result = layoutCheck();
        result.readout = [...stage.querySelectorAll('svg text')].map(t => (t.textContent || '').trim()).filter(t => t.length > 25).slice(0, 4);
        snapshot().then(png => post({ type: 'look', req: m.req, result, png }), err => post({ type: 'look', req: m.req, result, png: null, error: String(err && err.message || err) }));
      })();
    }
    else if (m.type === 'clear') { clearCanvas().then(() => post({ type: 'cleared', req: m.req })); }
  });

  fit();
  post({ type: 'ready' });
})();
