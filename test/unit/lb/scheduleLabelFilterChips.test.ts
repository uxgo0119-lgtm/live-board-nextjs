// [2026-08-16新設] 予定ラベル(scheduleLabels)に「表示専用ラベル」が混ざっても、既存の
// 絞り込みチップと絞り込み判定が変わらないことを固定する。
//
// 【なぜ必要か】
// 一括検証(test/batch)は renderFilterChips() をスタブにしているため、チップ側の回帰を見られない。
// 一方で、確定した記号がA/P以外(現状は'キャンセル')の部屋を部屋カードへ表示できるようにした
// 2026-08-16の修正で、scheduleLabels に text=null のラベルが入るようになった。
// ここを取りこぼすと「null」という名前のチップが増える／予定のキャンセルが
// 既存の「キャンセル」チップ(点検状態のキャンセル)へ混ざる、という利用者に見える壊れ方をする。
//
// index.html の実関数をそのまま取り出して動かす(別実装を持たない)。物件固有の値は使わない。

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const html = fs.readFileSync(path.join(process.cwd(), 'public/index.html'), 'utf8');

/* index.html から関数定義1つぶんのソースを、波括弧の対応で切り出す。 */
function extractFunctionSource(name: string): string {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('index.html に function ' + name + '() が見つからない');
  let depth = 0;
  let i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1) + '\n';
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

let chipsHtml = '';
const sandbox: Record<string, unknown> = {
  console, Object, String, Number, Array, JSON,
  scheduleLabels: {
    // A / P / 時刻 = 従来どおり絞り込み対象になるラベル
    '101': { text: 'A', color: '#A32D2D', timeDisplay: null },
    '102': { text: 'P', color: '#185FA5', timeDisplay: null },
    '103': { text: '09:30', color: '#A32D2D', timeDisplay: null },
    // A/P以外の確定記号 = 表示専用(text=null、symbolTextだけ持つ)
    '202': { text: null, symbolText: 'キャンセル', color: '#6B7280', timeDisplay: null },
    '204': { text: null, symbolText: 'キャンセル', color: '#6B7280', timeDisplay: null },
  },
  scheduleOverrides: {},
  activeFilter: null,
  // 点検状態としてのキャンセル(既存の「キャンセル」チップが対象にしてきた部屋)
  state: { '301': { status: 'cancelled' } },
  SENSOR_UNCONFIRMED_FILTER: '__sensor_unconfirmed__',
  sensorDisplayStateOf: () => ({ state: 'confirmed' }),
  document: { getElementById: () => ({ set innerHTML(v: string) { chipsHtml = v; } }) },
};
vm.createContext(sandbox);
vm.runInContext([
  extractFunctionSource('effectiveScheduleLabel'),
  extractFunctionSource('statusOf'),
  extractFunctionSource('renderFilterChips'),
  extractFunctionSource('roomMatchesFilter'),
].join('\n'), sandbox);

vm.runInContext('renderFilterChips();', sandbox);
const chipFilters = (chipsHtml.match(/data-filter="([^"]*)"/g) || [])
  .map((s) => s.replace(/^data-filter="/, '').replace(/"$/, ''));

assert(JSON.stringify(chipFilters) === JSON.stringify(['A', 'P', '09:30', '不在', 'キャンセル']),
  'チップはA/P/時刻/不在/キャンセルのまま。表示専用ラベルはチップを増やさない (got: ' + JSON.stringify(chipFilters) + ')');
assert(chipFilters.every((f) => f && f !== 'null' && f !== 'undefined'),
  '中身の無いチップ(null/undefined)が作られていない');

function matchedRooms(filter: string): string[] {
  (sandbox as { activeFilter: string }).activeFilter = filter;
  return ['101', '102', '103', '202', '204', '301']
    .filter((r) => vm.runInContext('roomMatchesFilter(' + JSON.stringify(r) + ')', sandbox));
}

assert(JSON.stringify(matchedRooms('キャンセル')) === JSON.stringify(['301']),
  '「キャンセル」チップは点検状態のキャンセルだけを拾う(予定の記号キャンセルは混ざらない)');
assert(JSON.stringify(matchedRooms('A')) === JSON.stringify(['101']), '「A」チップは従来どおり');
assert(JSON.stringify(matchedRooms('P')) === JSON.stringify(['102']), '「P」チップは従来どおり');
assert(JSON.stringify(matchedRooms('09:30')) === JSON.stringify(['103']), '時刻チップは従来どおり');

console.log('scheduleLabelFilterChips.test.ts: ALL PASS');
