// [2026-07-20新設] ApiErrorクラス単体をここに切り出している。
//
// なぜ lib/http/errors.ts から分離したか:
// errors.ts は next/server の NextResponse に依存しているため、Next.js
// (npm install済みの実行環境)でしか読み込めない。一方 ApiError クラス自体は
// 「ステータスコードとメッセージを持つ、ただのエラークラス」であり、
// lib/auth・lib/rateLimit・lib/invites・lib/ai などのビジネスロジック層は
// 本来Next.jsに依存する必要がない。ここを分離しておくことで、これらのロジックは
// next/server 無しでも(=単体テストでNext.js一式をインストールしなくても)
// importして動かせる(test/unit/配下の単体テストが依存しているのはこのファイルのみ)。

export class ApiError extends Error {
  public retryAfterSeconds?: number;
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
