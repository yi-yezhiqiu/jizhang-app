/* verify2 证据工具（Node 版，避免 PowerShell 重定向破坏 UTF-8/二进制）：
     node tools/verify2_run.mjs eval  <expr-file>          -> 打印结果
     node tools/verify2_run.mjs probe <expr-file> <out>    -> 结果写 UTF-8 文件
     node tools/verify2_run.mjs shot  <out.png>            -> adb exec-out screencap 写 PNG
     node tools/verify2_run.mjs tap   <cssX> <cssY>        -> 按 CSS 坐标真实触摸（自动乘以 dpr）
     node tools/verify2_run.mjs text  <string>             -> adb input text（键盘输入）
     node tools/verify2_run.mjs key   <keycode>            -> adb input keyevent
     node tools/verify2_run.mjs raw   <adb args...>        -> 直接跑 adb
   全部用 stdio 文件/参数，不经过 shell 管道。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ADB = 'D:\\android-sdk\\platform-tools\\adb.exe';
const PORT = process.env.CDP_PORT || 9222;
const cmd = process.argv[2];

function adb(args, opts = {}) {
  return spawnSync(ADB, args, { encoding: opts.encoding === undefined ? 'utf8' : opts.encoding, maxBuffer: 256 * 1024 * 1024 });
}

async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page found');
  return page;
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout waiting for CDP reply')); }, 20000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result;
      if (r && r.exceptionDetails) return reject(new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)));
      resolve(r && r.result ? r.result.value : undefined);
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('websocket error: ' + (e.message || 'unknown'))); });
  });
}

async function evalToText(exprFile) {
  const expr = fs.readFileSync(exprFile, 'utf8');
  const page = await getTarget();
  const v = await evaluate(page.webSocketDebuggerUrl, expr);
  return typeof v === 'string' ? v : JSON.stringify(v, null, 1);
}

async function shot(out) {
  const r = adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
  if (r.status !== 0) { console.error('adb screencap failed: ' + String(r.stderr)); process.exit(1); }
  fs.writeFileSync(out, r.stdout);
  const head = r.stdout.slice(0, 8).toString('hex');
  console.log(`shot -> ${out} bytes=${r.stdout.length} head=${head}`);
}

function dpr() {
  const r = adb(['shell', 'wm', 'density']);
  // Physical density: 420 -> dpr = 420/160 = 2.625
  const m = String(r.stdout).match(/(\d+)/);
  return m ? parseInt(m[1], 10) / 160 : 2.625;
}

async function main() {
  if (cmd === 'eval') {
    process.stdout.write(await evalToText(process.argv[3]) + '\n');
  } else if (cmd === 'probe') {
    const s = await evalToText(process.argv[3]);
    fs.writeFileSync(process.argv[4], s, 'utf8');
    console.log(`probe -> ${process.argv[4]} (${s.length} chars)`);
  } else if (cmd === 'shot') {
    await shot(process.argv[3]);
  } else if (cmd === 'tap') {
    const d = dpr();
    const x = Math.round(parseFloat(process.argv[3]) * d);
    const y = Math.round(parseFloat(process.argv[4]) * d);
    const r = adb(['shell', 'input', 'tap', String(x), String(y)]);
    console.log(`tap css(${process.argv[3]},${process.argv[4]}) -> phys(${x},${y}) status=${r.status}`);
  } else if (cmd === 'swipe') {
    const d = dpr();
    const a = process.argv.slice(3).map((v) => Math.round(parseFloat(v) * d));
    const r = adb(['shell', 'input', 'swipe', ...a.map(String)]);
    console.log('swipe -> ' + a.join(',') + ' status=' + r.status);
  } else if (cmd === 'text') {
    const r = adb(['shell', 'input', 'text', process.argv[3]]);
    console.log('text status=' + r.status);
  } else if (cmd === 'key') {
    const r = adb(['shell', 'input', 'keyevent', process.argv[3]]);
    console.log('key ' + process.argv[3] + ' status=' + r.status);
  } else if (cmd === 'raw') {
    const r = adb(process.argv.slice(3));
    process.stdout.write(String(r.stdout || ''));
    if (r.stderr) process.stderr.write(String(r.stderr));
  } else {
    console.error('unknown cmd: ' + cmd);
    process.exit(2);
  }
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
