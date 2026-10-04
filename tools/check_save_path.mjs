/* 检查 saveEntry 里是否有"可执行"的收键盘/改焦点动作。
   只看去掉注释后的代码，避免把说明文字误判成调用。

   用法: node tools/check_save_path.mjs <apk路径> */

import fs from 'node:fs';
import zlib from 'node:zlib';

const apk = process.argv[2] || 'JiZhang.apk';

function readZipEntry(buffer, wantedName) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 70000; i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wantedName) {
      const lNameLen = buffer.readUInt16LE(localOffset + 26);
      const lExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buffer.subarray(dataStart, dataStart + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('entry not found');
}

const js = readZipEntry(fs.readFileSync(apk), 'assets/www/js/app.js').toString('utf8');

// 去掉块注释与行注释，只留代码
const codeOnly = js
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const start = codeOnly.indexOf('function saveEntry()');
const nextFn = codeOnly.indexOf('/* ----------------', start + 1);
const body = codeOnly.slice(start, nextFn > start ? nextFn : start + 3000);

console.log('=== saveEntry（已剥离注释）===');
console.log(body.trim());

console.log('\n=== 可执行代码检查 ===');
const bad = {
  'dismissKeyboard(': body.includes('dismissKeyboard('),
  '.blur(': body.includes('.blur('),
  '.focus(': body.includes('.focus('),
  'scrollTo': body.includes('scrollTo'),
};
let clean = true;
for (const [k, v] of Object.entries(bad)) {
  console.log(k.padEnd(20) + ': ' + v);
  if (v) clean = false;
}
console.log('\n结论: ' + (clean
  ? '保存路径干净 —— 不碰键盘、不改焦点、不滚动'
  : '保存路径仍含有会影响键盘/焦点的动作'));

// 顺带确认保存按钮的触摸处理已就位
console.log('\n=== 保存按钮触摸处理 ===');
console.log('touchstart 里 preventDefault : ' + /saveBtn\.addEventListener\('touchstart'[\s\S]{0,200}?preventDefault\(\)/.test(codeOnly));
console.log('document touchstart 排除 saveBtn : ' + /closest\('#saveBtn'\)/.test(codeOnly));
console.log('click 有时间戳去重       : ' + /lastTouchSaveAt/.test(codeOnly));
