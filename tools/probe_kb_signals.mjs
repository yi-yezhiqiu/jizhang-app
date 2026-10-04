/* 探针：在设备上记录"键盘开合"期间所有候选信号的变化。
   目的：determine 键盘收起时到底有没有可观测事件（focusout / visualViewport / innerHeight）。

   用法: node tools/probe_kb_signals.mjs start    # 挂上监听并清空日志
         node tools/probe_kb_signals.mjs dump     # 读回日志
*/

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
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 20000);
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

const START = `(function(){
  if (window.__kbProbe) return 'already installed';
  var log = [];
  var t0 = Date.now();
  function snap(tag){
    var vv = window.visualViewport;
    var a = document.activeElement;
    log.push({
      t: Date.now() - t0,
      ev: tag,
      innerH: window.innerHeight,
      vvH: vv ? Math.round(vv.height) : null,
      vvTop: vv ? Math.round(vv.offsetTop) : null,
      active: a ? (a.id || a.tagName) : null,
      sheetKb: document.body.classList.contains('sheet-kb-open'),
      kbOpen: document.body.classList.contains('kb-open')
    });
  }
  window.__kbProbe = { log: log, snap: snap };
  snap('install');
  document.addEventListener('focusin', function(){ snap('focusin'); });
  document.addEventListener('focusout', function(){ setTimeout(function(){ snap('focusout+0'); }, 0); setTimeout(function(){ snap('focusout+300'); }, 300); });
  window.addEventListener('resize', function(){ snap('window.resize'); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function(){ snap('vv.resize'); });
    window.visualViewport.addEventListener('scroll', function(){ snap('vv.scroll'); });
  }
  document.addEventListener('visibilitychange', function(){ snap('visibility'); });
  return 'installed';
})()`;

const DUMP = `(function(){
  if (!window.__kbProbe) return 'not installed';
  return JSON.stringify(window.__kbProbe.log, null, 1);
})()`;

const mode = process.argv[2] || 'dump';
const page = await target();
const out = await run(page.webSocketDebuggerUrl, mode === 'start' ? START : DUMP);
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
