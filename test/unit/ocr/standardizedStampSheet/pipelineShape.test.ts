// [2026-08-15新設 Phase 2] パイプラインの「形」そのものを固定する構造テスト。
//
// Phase 2 の目的は機能追加ではなく引き算で、
//   実画像 → OCR raw → FireFlow辞書 → 業務ルール → normalize → 唯一の確定データ
// という一本道に近づけることだった。値の正しさは他のテストが見ているので、ここでは
// 「同じ判断をする場所が2つに増えていないか」だけを見る。
// 経路が増えたことに気付かないまま、以前の「ある回は直り、別の回で壊れる」状態へ
// 戻らないようにするための歯止め。

import * as fs from 'fs';
import * as path from 'path';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

const dir = path.join(__dirname, '..', '..', '..', '..', 'lib', 'ocr', 'standardizedStampSheet');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

// コメント(方針の説明で関数名に言及している箇所)は数えない。実際の呼び出しだけを見る。
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => l.trim().indexOf('//') !== 0).join('\n');
}

// --- 1. FireFlow辞書の適用位置は1箇所だけ ---
// 辞書は正式パイプラインの中で1回だけ引く。保存後・復元後・描画時に引き直さない、という
// 原則を守るには、まず lib 側で辞書を引く場所が1つである必要がある。
{
  const callers = files.filter((f) => f !== 'misreadDictionary.ts' && /matchAgainstDictionaries\s*\(/.test(stripComments(sourceOf(f))));
  assert(callers.length === 1,
    'FireFlow辞書(matchAgainstDictionaries)を呼ぶ場所は1つだけ (got: ' + callers.join(', ') + ')');
  assert(callers[0] === 'timeDesignation.ts',
    '辞書を引くのは時間指定行の備考を解釈する場所 (got: ' + callers[0] + ')');
}

// --- 2. 時刻の確定はマス単位の経路だけ ---
// 文字列だけを見る旧経路は、モデルが空マスを"0"で補完して返した場合に検知できず、
// 実API検証で1101・801の誤確定を招いた。復活させない。
{
  const grid = sourceOf('gridTimeParser.ts');
  assert(!/export function parseGridTime\s*\(/.test(grid),
    '文字列だけで時刻を確定する経路(parseGridTime)を復活させない');
  assert(/export function parseGridTimeCells\s*\(/.test(grid),
    'マス単位の時刻確定(parseGridTimeCells)が唯一の経路として存在する');
}

// --- 3. 正規化の入口は1つだけ ---
// 本体グリッドの行に時刻が入っている前提の旧経路を残すと、同じ帳票に対して2通りの
// 解釈結果が作れてしまう。
{
  const normalize = stripComments(sourceOf('normalizeStandardizedStamp.ts'));
  const exported = (normalize.match(/export function (\w+)/g) || []).map((m) => m.replace('export function ', ''));
  assert(exported.length === 1 && exported[0] === 'normalizeStandardizedStampScan',
    '正規化の入口は normalizeStandardizedStampScan だけ (got: ' + exported.join(', ') + ')');
}

console.log('pipelineShape.test.ts: ALL PASS');
