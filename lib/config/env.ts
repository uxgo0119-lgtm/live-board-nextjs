// [2026-07-20新設] サーバー専用の環境変数アクセス層。
//
// なぜこのファイルが必要か:
// このファイル(lib/config/env.ts)は、Route Handler(app/api/**/route.ts)や他のlib/配下の
// サーバー専用コードからのみimportしてください。Next.jsのApp Routerでは、
// ブラウザ側のJavaScriptバンドルに含まれるのは "use client" が付いたコンポーネントと、
// NEXT_PUBLIC_ プレフィックスを付けた環境変数だけです。このファイルが読む変数には
// 一つもNEXT_PUBLIC_を付けていないため、ここで扱う値(ANTHROPIC_API_KEY等)は
// ビルド後のクライアント向けJSバンドルに一切出力されません。
//
// このファイルをクライアントコンポーネント("use client"が付いたファイル)からimportしては
// いけません。Route Handler・Server Component・lib/配下のサーバー専用モジュールからのみ
// importする運用を徹底してください(ESLintの no-restricted-imports 等で機械的に強制することも
// 将来的には検討してください。100社規模になるほど「うっかりimport」のリスクが上がります)。

export class MissingEnvError extends Error {
  constructor(public readonly varName: string) {
    super(
      `サーバー側の環境変数 ${varName} が設定されていません。` +
        `Vercelのプロジェクト設定 → Settings → Environment Variables で設定するか、` +
        `ローカル開発では .env.local に設定してから再起動してください` +
        `(.env.local.example を参考にしてください)。`
    );
    this.name = 'MissingEnvError';
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new MissingEnvError(name);
  return v;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type ServerEnv = {
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // [2026-07-27改訂 Phase7] lib/ai/providers/openai/ が実装され、TASK_ROUTINGの値を
  // 'openai' に変更すると使われるようになった。ただし現時点でもTASK_ROUTINGの既定値は
  // 全タスクanthropicのままのため、未設定でも他の機能には影響しない(optionalのまま維持する)。
  // 実際にプロバイダをopenaiへ切り替える場合は、Vercel/.env.localにこの値を設定すること。
  OPENAI_API_KEY: string | null;
  // [2026-07-27新設 Phase7] lib/ai/providers/gemini/ が実装され、TASK_ROUTINGの値を
  // 'gemini' に変更すると使われるようになった。OPENAI_API_KEYと同様、現時点では
  // 未設定でも他の機能には影響しない(optional)。
  GEMINI_API_KEY: string | null;
  ALLOWED_ORIGINS: string[];
  RATE_LIMIT_WINDOW_SECONDS: number;
  RATE_LIMIT_MAX_PER_WINDOW: number;
  RATE_LIMIT_MAX_PER_USER_PER_DAY: number;
  RATE_LIMIT_MAX_GLOBAL_PER_DAY: number;
};

let cached: ServerEnv | null = null;

// 呼び出す都度process.envを読み直すのではなく、Route Handlerの中で
// getServerEnv()を呼んで必要な値だけを使ってください。値が無い場合はここで例外を
// 投げるため、Route Handler側は try/catch で捕まえて日本語エラーメッセージを
// そのままレスポンスに使えます(既存のapi/*.jsが持っていた「未設定なら親切な
// 日本語エラーを返す」という挙動を踏襲しています)。
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  cached = {
    ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),
    SUPABASE_URL: process.env.SUPABASE_URL || 'https://trtivspdgekofiglfyls.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || null,
    ALLOWED_ORIGINS: parseOrigins(process.env.ALLOWED_ORIGINS),
    RATE_LIMIT_WINDOW_SECONDS: optionalNumber('RATE_LIMIT_WINDOW_SECONDS', 60),
    RATE_LIMIT_MAX_PER_WINDOW: optionalNumber('RATE_LIMIT_MAX_PER_WINDOW', 5),
    RATE_LIMIT_MAX_PER_USER_PER_DAY: optionalNumber('RATE_LIMIT_MAX_PER_USER_PER_DAY', 200),
    RATE_LIMIT_MAX_GLOBAL_PER_DAY: optionalNumber('RATE_LIMIT_MAX_GLOBAL_PER_DAY', 5000),
  };
  return cached;
}

// テスト用: モジュールキャッシュをリセットする(単体テストで環境変数を切り替えるため)。
export function __resetServerEnvCacheForTests() {
  cached = null;
}
