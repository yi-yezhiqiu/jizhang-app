/* 通过 CDP Input.dispatchMouseEvent 派发真实鼠标事件（press+release），
   由坐标精度保证点中的就是目标元素；用于校验 click 绑定是否真的生效。
   用法: node tools/verify2_click.mjs <cssX> <cssY> [label]
         node tools/verify2_click.mjs --sel <cssSelector> [label] */
const PORT = process.env.CDP_PORT || 9222;

const selector = process.argv[2] === '--sel' ? process.argv[3] : null;
let cx = null, cy = null, label = '';
if (selector) {
  label = process.argv[4] || selector;
} else {
  cx = parseFloat(process.argv[2]);
  cy = parseFloat(process.argv[3]);
  label = process.argv[4] || `(${cx},${cy})`;
}

async function getPageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page found');
  return page;
}

function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'x'))));
  });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
  return { ws, ready, send };
}

const page = await getPageTarget();
const s = session(page.webSocketDebuggerUrl);
await s.ready;

if (selector) {
  const r = await s.send('Runtime.evaluate', {
    expression: `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;var r=el.getBoundingClientRect();return {x:Math.round((r.left+r.width/2)*100)/100,y:Math.round((r.top+r.height/2)*100)/100,w:r.width,h:r.height};})()`,
    returnByValue: true,
  });
  const v = r.result ? r.result.value : null;
  if (!v) { console.error('selector not found: ' + selector); process.exit(1); }
  cx = v.x; cy = v.y;
  console.log(`resolve ${selector} -> css(${cx},${cy}) size ${v.w}x${v.h}`);
}

const base = { x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 };
await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
await s.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
await new Promise((r) => setTimeout(r, 60));
await s.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
console.log(`dispatched mouse click at css(${cx},${cy}) label=${label}`);
s.ws.close();
