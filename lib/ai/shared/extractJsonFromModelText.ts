// [2026-07-20新設 / 2026-08-05改訂P0] モデルの返答テキストからJSONを取り出す共通処理。
// 特定のAIプロバイダに依存しない純粋なロジックなので providers/ ではなく shared/ に置く。
// lib/ai/providers/{anthropic,openai,gemini}/ocr.ts (本番のOcrCapability Adapter)が
// 直接importしている、本番のOCR経路にも影響する共有ファイルである。
//
// [2026-08-05改訂 P0] 捺印表OCR実測比較の結果、Anthropicが「JSON配列のみを出力し、
// 説明文を付けないこと」というプロンプト指示に従わず、JSON本体の前に説明文を
// 付けて応答するケースが実際に観測された(例: "この画像は...です。\n\n[{...}]")。
// 従来の実装(stripJsonFences→JSON.parse)はこのケースを解析できず、実際には
// 35部屋中35部屋を正しく読み取れていたにもかかわらず、解析失敗としてOCR結果
// 全体を握りつぶしていた。この改訂で、以下の段階的フォールバックへ強化した。
//
//   ①応答全文をそのままJSON.parse
//   ②Markdownコードブロック(```json ... ``` / ```text ... ``` 等)を抽出してJSON.parse
//   ③応答全文から、文字列リテラルを考慮したスタック方式の括弧探索でJSON本体を
//     特定してJSON.parse(単純な firstIndexOf/lastIndexOf は使わない。JSON文字列の
//     値の中に "[" "]" "{" "}" が含まれていても壊れないようにするため)
//
// 【重要な設計上の約束】
// - ①②で従来から成功していたケース(フェンス無しの素のJSON、```json ... ```で
//   囲まれたJSON)は、今回の変更後も同じ結果を返す(退行させない)。③は、従来
//   失敗していたケース(JSON前後に説明文が付くケース)を新たに救えるようにする、
//   純粋な追加のフォールバックである。
// - AIの出力内容そのものを書き換える処理は一切行わない(部屋番号の補完、時刻の
//   推測修正等は絶対に行わない。あくまで「モデルが返した文字列のどの範囲が
//   JSON本体か」を特定するだけ)。
// - stripJsonFences() の既存の挙動(エクスポート・シグネチャ・戻り値)は1文字も
//   変更していない(providers/*/ocr.ts がエラーログ用のプレビュー表示
//   (`stripJsonFences(text).slice(0, 500)`)として使っているため、そちらへの
//   影響を避けるため)。今回追加した新しいMarkdown抽出ロジックは、この関数とは
//   別の内部ヘルパーとして実装している。

export function stripJsonFences(text: string): string {
  return text.replace(/```json|```/g, '').trim();
}

export type JsonExtractionMethod = 'raw' | 'markdown' | 'bracket';

export type JsonExtractionResult = {
  value: unknown;
  method: JsonExtractionMethod;
};

// JSON抽出に失敗した場合の例外。attemptedMethodsに、どの方式まで試したかを残す
// (ログ出力用。個人情報を含みうる生テキストそのものは、呼び出し側の判断で
// 必要な範囲だけ別途ログに残すこと。このエラーのmessageには生テキストを含めない)。
export class JsonExtractionError extends Error {
  constructor(
    message: string,
    public readonly attemptedMethods: JsonExtractionMethod[]
  ) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

// ②Markdownコードブロック抽出。```json / ```text / 言語指定無しの```のいずれにも
// 対応する。フェンスの外側にある前後の文章は無視し、フェンス内部の文字列だけを
// 取り出す(stripJsonFencesのようにフェンス記号だけを除去して前後の文章を
// 残してしまうと、前後の文章が原因でJSON.parseに失敗するケースがあるため、
// 「フェンスの中身だけを抽出する」方式にしている)。
const MARKDOWN_FENCE_RE = /```(?:json|text)?[ \t]*\r?\n?([\s\S]*?)```/;

function extractFromMarkdownFence(text: string): unknown | undefined {
  const match = text.match(MARKDOWN_FENCE_RE);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return undefined;
  }
}

// 文字列リテラルを考慮しながら、text中の"["または"{"のうち、文字列の外側に
// あるものだけを候補開始位置として列挙する。
function findCandidateStartIndices(text: string): number[] {
  const indices: number[] = [];
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      indices.push(i);
    }
  }
  return indices;
}

// startIndexの"["または"{"に対応する閉じ括弧の位置を、スタック方式かつ
// 文字列リテラルを考慮して探索する。JSON文字列の値の中に"[" "]" "{" "}"が
// 含まれていても、文字列内部にある間は括弧としてカウントしない。
// 開き括弧と閉じ括弧の種類が一致しない場合(例: "["に対して"}"で閉じている)は
// 不正な構造とみなしnullを返す。
function findBalancedJsonSpanEnd(text: string, startIndex: number): number | null {
  const stack: Array<']' | '}'> = [];
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') {
      stack.push(']');
    } else if (ch === '{') {
      stack.push('}');
    } else if (ch === ']' || ch === '}') {
      if (stack.length === 0) return null; // 対応する開き括弧が無い
      const expected = stack.pop();
      if (expected !== ch) return null; // 括弧の種類が一致しない(不正な構造)
      if (stack.length === 0) return i; // startIndexまで完全に閉じた
    }
  }
  return null; // 最後まで閉じきらなかった
}

// ③応答全文から、文字列リテラルを考慮したスタック方式でJSON本体を探索する。
// 出現するすべての候補開始位置("["または"{"で、文字列の外側にあるもの)を
// 出現順に試し、対応する閉じ括弧までの範囲を抽出してJSON.parseを試みる。
// 最初にパースへ成功した候補を採用する(説明文中に無関係な"["等が混じっていても、
// パースに失敗すれば次の候補へ進むため頑健)。
function extractByBracketMatching(text: string): unknown | undefined {
  const candidates = findCandidateStartIndices(text);
  for (const start of candidates) {
    const end = findBalancedJsonSpanEnd(text, start);
    if (end === null) continue;
    const span = text.slice(start, end + 1);
    try {
      return JSON.parse(span);
    } catch {
      continue;
    }
  }
  return undefined;
}

// 段階的フォールバックでJSONを抽出し、どの方式で成功したかも返す
// (ログ・比較レポートでの「抽出方式」表示用)。
export function extractJsonFromModelTextDetailed(text: string): JsonExtractionResult {
  const attempted: JsonExtractionMethod[] = [];

  // ①応答全文をそのままJSON.parse
  attempted.push('raw');
  try {
    return { value: JSON.parse(text), method: 'raw' };
  } catch {
    // 次の方式へフォールバック
  }

  // ②Markdownコードブロック抽出
  attempted.push('markdown');
  const markdownResult = extractFromMarkdownFence(text);
  if (markdownResult !== undefined) {
    return { value: markdownResult, method: 'markdown' };
  }

  // ③スタック方式での括弧探索
  attempted.push('bracket');
  const bracketResult = extractByBracketMatching(text);
  if (bracketResult !== undefined) {
    return { value: bracketResult, method: 'bracket' };
  }

  throw new JsonExtractionError(
    'モデルの応答からJSONを抽出できませんでした(試行した方式: ' + attempted.join(' → ') + ')',
    attempted
  );
}

// 既存の呼び出し元(lib/ai/providers/{anthropic,openai,gemini}/ocr.ts)との後方互換の
// ための公開関数。シグネチャ(text: string) => unknown、失敗時に例外を投げる、という
// 契約は変更していない(呼び出し元は変更不要)。内部実装のみ、単純な
// JSON.parse(stripJsonFences(text))から、上記①②③の段階的抽出へ強化した。
export function extractJsonFromModelText(text: string): unknown {
  return extractJsonFromModelTextDetailed(text).value;
}

// ---- ④ Schema Validation ----
//
// 【設計判断】このファイルは複数の帳票種別(捺印表=6-7フィールド、紙の点検予定表=
// 9フィールド等)から共有される、帳票種別非依存のモジュールである。そのため、
// 特定の帳票のフィールド一覧をこのファイルにハードコードするのではなく、
// 呼び出し側が「必須の文字列フィールド一覧」をスキーマとして渡す、汎用的な
// バリデータとして実装する。今回のP0対応では、本番のAdapter(providers/*/ocr.ts)は
// このバリデータを呼び出すよう変更していない(呼び出し元を変更しないことで、
// 本番の挙動(バリデーションが無いこと)を変えない)。lib/ocr-compare/ (比較CLI)側で
// このバリデータを能動的に利用する。
export type ObjectShapeSchema = {
  // 存在し、かつ文字列型であることを要求するフィールド名の一覧。
  // (空文字列 "" は許容する。捺印表OCRの各フィールドは「読み取れなければ空文字」が
  // 正常値のため、空文字を不正値として扱ってはいけない。)
  requiredStringFields: string[];
};

export type SchemaValidationResult = { ok: true } | { ok: false; reason: string };

export function validateObjectShape(value: unknown, schema: ObjectShapeSchema): SchemaValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'JSONオブジェクトではありません' };
  }
  const obj = value as Record<string, unknown>;
  for (const key of schema.requiredStringFields) {
    if (!(key in obj)) {
      return { ok: false, reason: `必須キー "${key}" が存在しません` };
    }
    if (typeof obj[key] !== 'string') {
      return { ok: false, reason: `キー "${key}" の型が文字列ではありません(実際の型: ${typeof obj[key]})` };
    }
  }
  return { ok: true };
}

export function validateArrayShape(value: unknown, schema: ObjectShapeSchema): SchemaValidationResult {
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'JSON配列ではありません' };
  }
  for (let i = 0; i < value.length; i++) {
    const itemResult = validateObjectShape(value[i], schema);
    if (!itemResult.ok) {
      return { ok: false, reason: `配列${i}番目の要素: ${itemResult.reason}` };
    }
  }
  return { ok: true };
}
