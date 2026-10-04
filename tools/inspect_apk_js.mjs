/* 从构建好的 APK 里取出 app.js，并检查 saveEntry 是否还残留"收键盘"的动作。
   用途：确认手机上装的那份包，与源码是否一致。

   用法: node tools/inspect_apk_js.mjs <apk路径> [要找的函数名] */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const apk = process.argv[2] || 'JiZhang.apk';
const fnName = process.argv[3] || 'function saveEntry()';

const buf = fs.readFileSync(apk);

/* 最小 ZIP 读取：遍历本地文件头，找到目标条目再解压。
   只需支持 deflate/stored，够用且不引入依赖。 */
function readZipEntry(buffer, wantedName) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 70000; i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('end of central directory not found');

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory header');
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === wantedName) {
      const lp = localOffset;
      if (buffer.readUInt32LE(lp) !== 0x04034b50) throw new Error('bad local header');
      const lNameLen = buffer.readUInt16LE(lp + 26);
      const lExtraLen = buffer.readUInt16LE(lp + 28);
      const dataStart = lp + 30 + lNameLen + lExtraLen;
      const data = buffer.subarray(dataStart, dataStart + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('entry not found: ' + wantedName);
}

const js = readZipEntry(buf, 'assets/www/js/app.js').toString('utf8');
console.log('APK: ' + path.resolve(apk));
console.log('app.js 大小: ' + js.length + ' 字符');

const start = js.indexOf(fnName);
if (start < 0) {
  console.log('未找到 ' + fnName);
  process.exit(1);
}
const nextFn = js.indexOf('/* ----------------', start + 1);
const end = nextFn > start ? nextFn : js.length;
const body = js.slice(start, end);

console.log('\n=== ' + fnName + ' 全文 ===');
console.log(body);

console.log('=== 检查结果 ===');
const checks = {
  '含 dismissKeyboard': body.includes('dismissKeyboard'),
  '含 .blur(': body.includes('.blur('),
  '含 .focus(': body.includes('.focus('),
};
for (const [k, v] of Object.entries(checks)) {
  console.log(k.padEnd(22) + ': ' + v + (v ? '   <-- 需要关注' : ''));
}
