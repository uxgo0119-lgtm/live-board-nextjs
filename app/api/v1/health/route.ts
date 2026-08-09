// [2026-07-20新設] 死活監視・デプロイ確認用のヘルスチェック。認証不要・秘密情報を
// 一切含まない。Vercelへのデプロイ後、まずこのURL(/api/v1/health)にアクセスして
// 200 OKが返ることを確認すると、Route Handler自体が正しく動いているかを
// 環境変数の設定状況を気にせず確認できる。

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ ok: true, service: 'fireflow-api', version: 'v1' });
}
