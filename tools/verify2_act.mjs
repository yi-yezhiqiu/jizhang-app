/* 单连接完成：可选点击元素/坐标 -> 等待 -> 回读页面状态。
   避免多次连接之间页面状态漂移。
   用法:
     node tools/verify2_act.mjs --page settings
     node tools/verify2_act.mjs --sel '.chip-move' --index 1 --click
     node tools/verify2_act.mjs --eval "<js>"
     node tools/verify2_act.mjs --eval "<js>" --click-at <cssX> <cssY>   (先点再读)  */
const PORT = process.env.CDP_PORT || 9222;

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
const wantPage = opt('--page');
const sel = opt('--sel');
const index = opt('--index') ? parseInt(opt('--index'), 10) : 0;
const doClick = argv.includes('--click');
const evalExpr = opt('--eval');
const caIdx = argv.indexOf('--click-at');
const clickAt = caIdx >= 0 ? [parseFloat(argv[caIdx + 1]), parseFloat(argv[caIdx + 2])] : null;

const READ = `(function(){
  var vis = [].slice.call(document.querySelectorAll('.page')).filter(function(p){return !p.hidden}).map(function(p){return p.id});
  var chips = [].slice.call(document.querySelectorAll('.chip-move')).map(function(b){
    var r = b.getBoundingClientRect();
    return { t: b.textContent.trim(), dir: b.getAttribute('data-dir'), dis: b.disabled,
             cx: Math.round((r.left+r.width/2)*100)/100, cy: Math.round((r.top+r.height/2)*100)/100,
             x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return { page: vis[0]||null, activeEl: document.activeElement?(document.activeElement.id||document.activeElement.tagName):null,
           bodyClass: document.body.className, toast: document.getElementById('toast').textContent,
           toastHidden: document.getElementById('toast').hidden,
           masks: ['goalMask','savedMask','editMask','dateMask','confirmMask'].filter(function(id){var e=document.getElementById(id);return e&&!e.hidden}),
           expOrder: Store.Categories.byType('expense').map(function(c){return c.name}),
           incOrder: Store.Categories.byType('income').map(function(c){return c.name}),
           chips: chips.slice(0, 8), chipCount: chips.length };
})()`;

async function getPageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page found');
  return page;
}

function connect(wsUrl) {
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
const s = connect(page.webSocketDebuggerUrl);
await s.ready;

async function evaluate(expr) {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}

async function mouseClick(x, y) {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await s.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await new Promise((r) => setTimeout(r, 60));
  await s.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

if (wantPage) {
  const r = await evaluate(`(function(){var t=document.querySelector('.tab[data-page="' + ${JSON.stringify(wantPage)} + '"]');if(!t)return 'no-tab';t.click();return 'clicked';})()`);
  console.log('switch page: ' + r);
  await new Promise((r) => setTimeout(r, 500));
}

if (evalExpr) {
  const v = await evaluate(evalExpr);
  console.log('eval => ' + (typeof v === 'string' ? v : JSON.stringify(v)));
  await new Promise((r) => setTimeout(r, 400));
}

if (clickAt) {
  await mouseClick(clickAt[0], clickAt[1]);
  console.log(`clicked at css(${clickAt[0]},${clickAt[1]})`);
  await new Promise((r) => setTimeout(r, 700));
}

if (sel) {
  const info = await evaluate(`(function(){var els=document.querySelectorAll(${JSON.stringify(sel)});var el=els[${index}];if(!el)return null;var r=el.getBoundingClientRect();return {cx:Math.round((r.left+r.width/2)*100)/100,cy:Math.round((r.top+r.height/2)*100)/100,w:Math.round(r.width),h:Math.round(r.height),txt:el.textContent.trim(),dis:el.disabled};})()`);
  if (!info) { console.error('selector not found: ' + sel + ' index ' + index); process.exit(1); }
  console.log('target ' + sel + '[' + index + '] => ' + JSON.stringify(info));
  if (doClick) {
    await mouseClick(info.cx, info.cy);
    console.log('clicked target');
    await new Promise((r) => setTimeout(r, 800));
  }
}

const state = await evaluate(READ);
console.log('STATE ' + JSON.stringify(state, null, 1));
s.ws.close();
