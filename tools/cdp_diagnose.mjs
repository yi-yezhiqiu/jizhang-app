/* 真机/模拟器状态探测脚本：一次性检查这几个易出问题的点。
   用法: node tools/cdp_diagnose.mjs
   依赖: 已通过 adb forward 把调试端口映射到 9222 */

const PORT = process.env.CDP_PORT || 9222;

async function target() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await r.json();
  const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!p) throw new Error('no debuggable page');
  return p;
}

function run(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 15000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (m.error) return reject(new Error(JSON.stringify(m.error)));
      const r = m.result;
      if (r && r.exceptionDetails) {
        return reject(new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      resolve(r && r.result ? r.result.value : undefined);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
  });
}

const EXPR = `(function(){
  function rectOf(id){
    var el = document.getElementById(id);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return {
      id: id,
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents
    };
  }
  // 落在备注框中心的元素是谁？如果不是备注框本身，说明被遮挡了
  var ni = document.getElementById('noteInput');
  var nr = ni.getBoundingClientRect();
  var cx = Math.round(nr.left + nr.width / 2);
  var cy = Math.round(nr.top + nr.height / 2);
  var hit = document.elementFromPoint(cx, cy);

  var ai = document.getElementById('amountInput');
  var ar = ai.getBoundingClientRect();
  var acx = Math.round(ar.left + ar.width / 2);
  var acy = Math.round(ar.top + ar.height / 2);
  var ahit = document.elementFromPoint(acx, acy);

  return JSON.stringify({
    viewport: { innerH: window.innerHeight,
                vvH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
                vvTop: window.visualViewport ? Math.round(window.visualViewport.offsetTop) : null },
    bodyClass: document.body.className,
    activeElement: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    entryZoneInline: { top: document.getElementById('entryZone').style.top || '(空)',
                       bottom: document.getElementById('entryZone').style.bottom || '(空)' },
    kbTight: document.getElementById('entryZone').classList.contains('kb-tight'),
    amount: rectOf('amountInput'),
    note: rectOf('noteInput'),
    noteHitTest: { point: [cx, cy], elementAtPoint: hit ? (hit.id || hit.className || hit.tagName) : null,
                   isNoteInput: hit === ni },
    amountHitTest: { point: [acx, acy], elementAtPoint: ahit ? (ahit.id || ahit.className || ahit.tagName) : null,
                     isAmountInput: ahit === ai }
  }, null, 1);
})()`;

try {
  const p = await target();
  const out = await run(p.webSocketDebuggerUrl, EXPR);
  console.log(out);
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}
