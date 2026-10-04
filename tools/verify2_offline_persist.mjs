/* verify2 离线持久化测试：验证攒钱数据、攒钱记录确实写进了 localStorage 的键里，
   并且在「重新加载 store.js」后仍然读得到（模拟 App 重启）。
   注意：这是**离线数据层**证据（stub localStorage），不等于设备上 force-stop 重启的实测。

   用法: node tools/verify2_offline_persist.mjs */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync('app/src/main/assets/www/js/store.js', 'utf8');

/* 一个「手机存储」：进程内存里的 Map，跨 store.js 实例共享 */
const disk = new Map();

function loadStore() {
  const localStorage = {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => { disk.set(k, String(v)); },
    removeItem: (k) => { disk.delete(k); },
  };
  const sandbox = { localStorage, console, JSON, Date, Math, Number, String, Array, Object, parseInt, parseFloat, isNaN, RegExp, Error };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'store.js' });
  return sandbox.Store;
}

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${desc}${detail !== undefined ? ' :: ' + detail : ''}`);
}

/* ---- 第一次「运行」：建目标、存钱 ---- */
const S1 = loadStore();
const addRes = S1.Savings.add({ name: '重启后要还在', targetAmount: '3000', targetDate: '2026-12-31', icon: '🚗' });
const goal1 = S1.Savings.all()[0];
S1.Savings.deposit(goal1.id, '500');
S1.Savings.withdraw(goal1.id, '200');
const savedBefore = S1.Savings.savedAmount(goal1.id);
check('p1-written', '第一次运行：目标已建、已攒 = 300', addRes.ok && savedBefore === 30000,
  JSON.stringify({ addRes, goalId: goal1.id, savedAmount: savedBefore }));
check('p2-keys-exist', 'localStorage 里出现了攒钱目标键与记录键',
  disk.has('jizhang.savingsGoals.v1') && disk.has('jizhang.records.v1'),
  JSON.stringify([...disk.keys()]));

/* ---- 第二次「运行」：重新加载 store.js（模拟 App 重启） ---- */
const S2 = loadStore();
const savedAfter = S2.Savings.savedAmount(goal1.id);
const goalAfter = S2.Savings.get(goal1.id);
const savingsRecs = S2.Records.all().filter((r) => r.goalId === goal1.id);
check('p3-goal-survives-restart', '重启后目标仍在（名称/目标金额/日期/图标都在）',
  !!goalAfter && goalAfter.name === '重启后要还在' && goalAfter.targetAmount === 300000 &&
  goalAfter.targetDate === '2026-12-31' && goalAfter.icon === '🚗',
  JSON.stringify(goalAfter));
check('p4-saved-survives-restart', '重启后已攒仍是 300（由攒钱记录汇总而来）', savedAfter === 30000,
  `before=${savedBefore} after=${savedAfter}`);
check('p5-savings-records-survive', '重启后两条攒钱记录（1 存 1 取）都还在',
  savingsRecs.length === 2 && savingsRecs.some((r) => r.savingsKind === 'in') && savingsRecs.some((r) => r.savingsKind === 'out'),
  JSON.stringify(savingsRecs.map((r) => ({ a: r.amount, k: r.savingsKind, t: r.type }))));

/* ---- 目标删除后重启：目标消失但记录还在（记录不随目标删除） ---- */
S2.Savings.remove(goal1.id);
const S3 = loadStore();
check('p6-goal-removed-survives', '删除目标后重启：目标列表为空', S3.Savings.all().length === 0,
  JSON.stringify(S3.Savings.all()));
check('p7-records-kept-after-goal-removal', '但记账记录不受影响（2 条仍在，已攒合计仍算得出来）',
  S3.Records.all().filter((r) => r.goalId === goal1.id).length === 2 && S3.Savings.savedTotal() === 30000,
  `recs=${S3.Records.all().filter((r) => r.goalId).length} savedTotal=${S3.Savings.savedTotal()}`);

/* ---- 写坏一个键：不能抛错、不能把别的键带坏 ---- */
disk.set('jizhang.savingsGoals.v1', '{ this is not json');
const S4 = loadStore();
let threw = null;
let goals = null;
try { goals = S4.Savings.all(); } catch (e) { threw = String(e); }
check('p8-corrupt-goals-key-safe', '攒钱目标键损坏时不抛错（返回空数组）', threw === null && Array.isArray(goals) && goals.length === 0,
  `threw=${threw} goals=${JSON.stringify(goals)}`);

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
fs.writeFileSync('verify2-out/offline-persist-result.json', JSON.stringify({
  source: 'app/src/main/assets/www/js/store.js',
  note: '离线数据层持久化（stub localStorage + 重新加载模块），不等于设备 force-stop 重启实测',
  pass, fail, results,
}, null, 1), 'utf8');
console.log(`\n=== offline persist: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
