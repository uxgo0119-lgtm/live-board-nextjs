// [2026-08-05新設 P0] lib/ai/shared/extractJsonFromModelText.ts の単体テスト。
//
// FireFlow OCR JSON解析処理改善(P0)実装依頼で明示的に要求された8ケース
// (①JSONのみ ②説明文＋JSON ③Markdown＋JSON ④前後文章＋JSON
//  ⑤JSON文字列中に[]{}を含むケース ⑥不正JSON ⑦Schema違反 ⑧空応答)に加え、
// 実際にコスモ茨木穂積物件で観測された、Anthropicが説明文を前置きしたために
// 従来ロジックでは0%扱いになっていた実データ(35部屋)を使った回帰テストを追加する。
//
// 【重要】このテストは「JSON抽出処理」だけを検証する。AI出力内容の書き換え・
// 部屋番号/時刻の補完・自動補正などは一切行っていないことも、抽出結果が
// 入力と完全一致すること(値の変更が無いこと)で確認する。

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractJsonFromModelText,
  extractJsonFromModelTextDetailed,
  JsonExtractionError,
  stripJsonFences,
  validateArrayShape,
  validateObjectShape,
  type ObjectShapeSchema,
} from '../../../../lib/ai/shared/extractJsonFromModelText';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

function assertThrows(fn: () => unknown, msg: string) {
  try {
    fn();
    throw new Error('FAIL(例外が発生しなかった): ' + msg);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('FAIL(')) throw err;
    console.log('OK: ' + msg);
  }
}

const STAMP_SHEET_ENTRY_SCHEMA: ObjectShapeSchema = {
  requiredStringFields: ['room_number', 'symbol', 'time', 'time_end', 'note', 'name', 'date'],
};

// ==========================================================================
// ① JSONのみ
// ==========================================================================
{
  const text = '[{"room_number":"101","symbol":"A","time":"09:00","time_end":"","note":"","name":"","date":"2024年8月25日"}]';
  const result = extractJsonFromModelTextDetailed(text);
  assert(result.method === 'raw', '①JSONのみ: methodは"raw"');
  assert(Array.isArray(result.value) && (result.value as unknown[]).length === 1, '①JSONのみ: 配列1件をパースできる');
  assert(extractJsonFromModelText(text) !== undefined, '①JSONのみ: extractJsonFromModelText(後方互換API)でも抽出できる');
}

// ==========================================================================
// ② 説明文＋JSON (JSON本体の前に説明文のみが付くケース)
// ==========================================================================
{
  const text =
    'この画像は個別の連絡票ではなく、管理側が作成した点検スケジュール一覧表です。\n\n' +
    '[{"room_number":"602","symbol":"","time":"11:00","time_end":"","note":"","name":"","date":"2024年8月25日"}]';
  const result = extractJsonFromModelTextDetailed(text);
  assert(result.method === 'bracket', '②説明文＋JSON: raw/markdownでは解析できず、③括弧探索で抽出される(method="bracket")');
  const arr = result.value as Array<Record<string, unknown>>;
  assert(Array.isArray(arr) && arr.length === 1, '②説明文＋JSON: 配列1件をパースできる');
  assert(arr[0].room_number === '602', '②説明文＋JSON: room_numberの値が書き換えられずそのまま抽出される');
}

// ==========================================================================
// ③ Markdown＋JSON (```json ... ``` フェンス)
// ==========================================================================
{
  const text = '```json\n[{"room_number":"203","symbol":"P","time":"10:00","time_end":"","note":"","name":"","date":"2024年8月25日"}]\n```';
  const result = extractJsonFromModelTextDetailed(text);
  assert(result.method === 'markdown', '③Markdown＋JSON(```json): methodは"markdown"');
  const arr = result.value as Array<Record<string, unknown>>;
  assert(arr[0].room_number === '203', '③Markdown＋JSON(```json): 値が正しく抽出される');
}
{
  // ```text フェンスのバリエーションも要求されている(②③どちらも考慮すること、と明記あり)
  const text = '```text\n[{"room_number":"204","symbol":"","time":"10:30","time_end":"","note":"","name":"","date":"2024年8月25日"}]\n```';
  const result = extractJsonFromModelTextDetailed(text);
  assert(result.method === 'markdown', '③Markdown＋JSON(```text): methodは"markdown"');
  const arr = result.value as Array<Record<string, unknown>>;
  assert(arr[0].room_number === '204', '③Markdown＋JSON(```text): 値が正しく抽出される');
}

// ==========================================================================
// ④ 前後文章＋JSON (JSON本体の前後の両方に説明文が付くケース)
// ==========================================================================
{
  const text =
    '読み取り結果は以下の通りです。\n\n' +
    '[{"room_number":"301","symbol":"","time":"13:00","time_end":"","note":"","name":"","date":"2024年8月25日"}]' +
    '\n\n以上、ご確認ください。';
  const result = extractJsonFromModelTextDetailed(text);
  assert(result.method === 'bracket', '④前後文章＋JSON: ③括弧探索で抽出される(method="bracket")');
  const arr = result.value as Array<Record<string, unknown>>;
  assert(arr.length === 1 && arr[0].room_number === '301', '④前後文章＋JSON: 前後の文章を無視してJSON本体のみ正しく抽出される');
}

// ==========================================================================
// ⑤ JSON文字列中に [] {} を含むケース
//    (単純な firstIndexOf("[")/lastIndexOf("]") では、文字列値の中の括弧に
//    惑わされて誤ったスパンを切り出してしまう。スタック方式かつ文字列
//    リテラルを考慮した実装であることを確認する。)
// ==========================================================================
{
  const text =
    '説明: このメモには記号 [注意] や {重要} が含まれます。\n\n' +
    '[{"room_number":"402","symbol":"","time":"","time_end":"","note":"備考: [鍵は管理人へ] {インターホン}故障中","name":"","date":"2024年8月25日"}]' +
    '\n\n(この文章にも余計な ] や } が混じっています)';
  const result = extractJsonFromModelTextDetailed(text);
  assert(result.method === 'bracket', '⑤文字列中に[]{}を含むケース: ③括弧探索で抽出される');
  const arr = result.value as Array<Record<string, unknown>>;
  assert(arr.length === 1, '⑤文字列中に[]{}を含むケース: 前後の説明文中の括弧に惑わされず、正しく1件だけ抽出される');
  assert(
    arr[0].note === '備考: [鍵は管理人へ] {インターホン}故障中',
    '⑤文字列中に[]{}を含むケース: JSON文字列値の中の[]{}が壊れずそのまま保持される'
  );
}

// ==========================================================================
// ⑥ 不正JSON (どの方式でも解析できない)
// ==========================================================================
{
  const text = 'これは説明文だけで、JSONが全く含まれていない応答です。';
  assertThrows(() => extractJsonFromModelTextDetailed(text), '⑥不正JSON(JSON自体が無い): JsonExtractionErrorが投げられる');

  try {
    extractJsonFromModelTextDetailed(text);
  } catch (err) {
    assert(err instanceof JsonExtractionError, '⑥不正JSON: 投げられる例外の型はJsonExtractionError');
    if (err instanceof JsonExtractionError) {
      assert(
        err.attemptedMethods.join(',') === 'raw,markdown,bracket',
        '⑥不正JSON: 3方式すべて試行したことがattemptedMethodsに記録される'
      );
    }
  }
}
{
  // 括弧はあるが壊れた構造(閉じ括弧が対応しない)
  const text = '結果: [{"room_number":"999","symbol":"" "time":"09:00"]';
  assertThrows(() => extractJsonFromModelTextDetailed(text), '⑥不正JSON(壊れた括弧構造): JsonExtractionErrorが投げられる');
}

// ==========================================================================
// ⑦ Schema違反 (JSON解析には成功するが、必須フィールドが欠けている/型が違う)
// ==========================================================================
{
  const text = '[{"room_number":"501","time":"09:00"}]'; // symbol/time_end/note/name/date が無い
  const result = extractJsonFromModelTextDetailed(text);
  assert(result.method === 'raw', '⑦Schema違反: JSON自体の解析(raw)には成功する');
  const validation = validateArrayShape(result.value, STAMP_SHEET_ENTRY_SCHEMA);
  assert(validation.ok === false, '⑦Schema違反: 必須キー欠落はSchema Validationでok=falseになる');
  if (!validation.ok) {
    assert(validation.reason.includes('symbol'), '⑦Schema違反: 欠落キー名(symbol)が理由に含まれる');
  }
}
{
  // 型違反(room_numberが数値)
  const text = '[{"room_number":501,"symbol":"","time":"09:00","time_end":"","note":"","name":"","date":"2024年8月25日"}]';
  const result = extractJsonFromModelTextDetailed(text);
  const validation = validateArrayShape(result.value, STAMP_SHEET_ENTRY_SCHEMA);
  assert(validation.ok === false, '⑦Schema違反(型違反): room_numberが数値型だとok=falseになる');
}
{
  // 空文字列は正常値として許容されること(捺印表OCRでは「読み取れなければ空文字」が正しい)
  const text =
    '[{"room_number":"501","symbol":"","time":"","time_end":"","note":"","name":"","date":""}]';
  const result = extractJsonFromModelTextDetailed(text);
  const validation = validateArrayShape(result.value, STAMP_SHEET_ENTRY_SCHEMA);
  assert(validation.ok === true, '⑦Schema違反(境界値): 空文字列のフィールドは不正値ではなく正常値として扱われる');
}
{
  // オブジェクト単体(single mode相当)のSchema Validation
  const validObj = { room_number: '101', symbol: 'A', time: '09:00', time_end: '', note: '', name: '', date: '2024年8月25日' };
  assert(validateObjectShape(validObj, STAMP_SHEET_ENTRY_SCHEMA).ok === true, '⑦Schema違反: 単一オブジェクトの正常系はok=true');
  assert(validateObjectShape([validObj], STAMP_SHEET_ENTRY_SCHEMA).ok === false, '⑦Schema違反: 配列をvalidateObjectShapeに渡すとok=false(オブジェクトではない)');
}

// ==========================================================================
// ⑧ 空応答
// ==========================================================================
{
  assertThrows(() => extractJsonFromModelTextDetailed(''), '⑧空応答(完全な空文字列): JsonExtractionErrorが投げられる');
  assertThrows(() => extractJsonFromModelTextDetailed('   \n\t  '), '⑧空応答(空白のみ): JsonExtractionErrorが投げられる');
}

// ==========================================================================
// stripJsonFences: 既存の戻り値仕様(1文字も変更していないことの回帰確認)。
// providers/*/ocr.ts がエラーログのプレビュー表示に使っているため、
// シグネチャ・挙動が変わっていないことを明示的に確認する。
// ==========================================================================
{
  assert(stripJsonFences('```json\n[1,2,3]\n```') === '[1,2,3]', 'stripJsonFences: 既存の挙動(```json除去)が維持されている');
  assert(stripJsonFences('素のテキスト') === '素のテキスト', 'stripJsonFences: フェンスが無い場合はそのまま返す(既存の挙動)');
}

// ==========================================================================
// 実データ回帰テスト: 2026-08-05 コスモ茨木穂積物件の実測比較で、実際に
// Anthropicから返ってきた生レスポンス(説明文＋35部屋のJSON配列、4176文字)。
// 従来の実装(stripJsonFences→JSON.parseのみ)ではこの入力は解析に失敗し、
// 35部屋すべてが「欠落」として扱われていた(実測比較レポートで確認済み)。
// この回帰テストは、その実データそのものを使って、今回のP0修正で
// 実際に解析が成功するようになったことを検証する。
// ==========================================================================
{
  const fixturePath = join(__dirname, 'fixtures', 'anthropic_real_raw_ibarakihozumi_2026-08-05.txt');
  const realRawText = readFileSync(fixturePath, 'utf-8');

  assert(realRawText.length > 0, '実データ回帰: フィクスチャファイルが読み込める');
  assert(
    !realRawText.trim().startsWith('[') && !realRawText.trim().startsWith('{'),
    '実データ回帰: この入力は先頭が説明文であり、単純なJSON.parseでは失敗する入力であることの前提確認'
  );

  // 従来方式(stripJsonFences→JSON.parseのみ)では失敗することも明示的に確認しておく
  // (「今回の修正が無ければ本当に失敗していた」ことの裏付け)。
  let legacyFailed = false;
  try {
    JSON.parse(stripJsonFences(realRawText));
  } catch {
    legacyFailed = true;
  }
  assert(legacyFailed, '実データ回帰: 従来方式(stripJsonFences→JSON.parseのみ)ではこの実データは解析に失敗する(修正前の実際の不具合の再現)');

  const result = extractJsonFromModelTextDetailed(realRawText);
  assert(result.method === 'bracket', '実データ回帰: 新方式では③括弧探索(method="bracket")で解析に成功する');

  const rooms = result.value as Array<Record<string, unknown>>;
  assert(Array.isArray(rooms), '実データ回帰: 解析結果はJSON配列である');
  assert(rooms.length === 35, `実データ回帰: 35部屋すべてが抽出される(実際: ${rooms.length}件)`);

  const roomNumbers = rooms.map((r) => r.room_number);
  assert(roomNumbers.includes('602'), '実データ回帰: 実データ内の部屋番号(602)が正しく抽出される(値の書き換え無し)');
  assert(roomNumbers.includes('107'), '実データ回帰: 実データ内の部屋番号(107)が正しく抽出される(値の書き換え無し)');

  const room107 = rooms.find((r) => r.room_number === '107');
  assert(
    room107 !== undefined && room107.note === '9:00前に鍵一緒で',
    '実データ回帰: room107のnote値が原文のまま(補完・修正されず)抽出される'
  );

  const validation = validateArrayShape(rooms, STAMP_SHEET_ENTRY_SCHEMA);
  assert(validation.ok === true, '実データ回帰: 抽出結果はSchema Validationにも合格する(7フィールドすべて文字列型で存在)');
}

console.log('ALL PASS: ai/shared/extractJsonFromModelText.test.ts');
