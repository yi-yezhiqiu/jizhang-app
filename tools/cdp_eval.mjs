/* CDP 调试客户端：连到模拟器里 WebView 的调试端口，执行任意 JS 表达式。
   用途：在没有可用触摸输入的环境里，直接读取页面真实状态来定位问题。

   用法:
     node cdp_eval.mjs "<javascript expression>"
     node cdp_eval.mjs --file <path-to-js>

   依赖 Node 内置 WebSocket（Node 22+）。 */

const PORT = process.env.CDP_PORT || 9222;

async function getPageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page found');
  return page;
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('timeout waiting for CDP reply'));
    }, 15000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) {
        reject(new Error(JSON.stringify(msg.error)));
        return;
      }
      const r = msg.result;
      if (r && r.exceptionDetails) {
        reject(new Error('page exception: ' +
          (r.exceptionDetails.exception?.description || r.exceptionDetails.text)));
        return;
      }
      resolve(r && r.result ? r.result.value : undefined);
    });

    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error('websocket error: ' + (e.message || 'unknown')));
    });
  });
}

const args = process.argv.slice(2);
let expr;
if (args[0] === '--file') {
  const fs = await import('node:fs');
  expr = fs.readFileSync(args[1], 'utf8');
} else {
  expr = args.join(' ');
}

if (!expr) {
  console.error('usage: node cdp_eval.mjs "<expression>" | --file <path>');
  process.exit(2);
}

try {
  const page = await getPageTarget();
  const value = await evaluate(page.webSocketDebuggerUrl, expr);
  if (typeof value === 'string') {
    process.stdout.write(value + '\n');
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  }
} catch (err) {
  console.error('ERROR: ' + err.message);
  process.exit(1);
}
