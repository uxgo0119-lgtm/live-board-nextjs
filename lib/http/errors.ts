// [2026-07-20新設] Route Handler共通のエラー/JSONレスポンスヘルパー(Next.js依存部分)。
// 以前のapi/*.js(素のVercel Functions)では各ファイルがres.status().json()を個別に
// 呼んでいたが、Route Handlerでは NextResponse.json() を使う。エラー形状({error: "..."})は
// 既存フロントエンド(index.html・join.html)がそのまま解釈できるよう完全に踏襲している
// (data.error を読んでいる箇所を参照)。
//
// ApiErrorクラス自体は ./apiError.ts に切り出してある(Next.js非依存にするため。
// 詳細はそちらのコメント参照)。ここでは再エクスポートし、既存の
// `import { ApiError } from '@/lib/http/errors'` という書き方をそのまま使えるようにする。

import { NextResponse } from 'next/server';
import { ApiError } from './apiError';

export { ApiError } from './apiError';

export function errorResponse(status: number, message: string, extraHeaders?: HeadersInit) {
  return NextResponse.json({ error: message }, { status, headers: extraHeaders });
}

export function okResponse(result: unknown, extraHeaders?: HeadersInit, status = 200) {
  return NextResponse.json({ result }, { status, headers: extraHeaders });
}

// Route Handler内で使う共通のtry/catchラッパー。ApiErrorはそのままステータス・
// メッセージを使い、それ以外の想定外エラーは500として返しつつ、原因はサーバーの
// ログ(console.error)にだけ残す(スタックトレース等の内部情報をブラウザに漏らさないため)。
//
// extraHeaders は、エラー応答にも必ず付けたいヘッダ(CORSのAccess-Control-Allow-Origin等)を
// 渡すためのもの。ここで付け忘れると、拒否理由(レート制限・未ログイン等)のエラー
// メッセージがCORSでブロックされてブラウザ側から読めず、ユーザーには原因不明の
// 通信エラーにしか見えなくなってしまうため、必ず渡すこと。
export async function withErrorHandling(
  handler: () => Promise<Response>,
  extraHeaders?: HeadersInit
): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof ApiError) {
      const headers = new Headers(extraHeaders);
      if (err.retryAfterSeconds) headers.set('Retry-After', String(err.retryAfterSeconds));
      return errorResponse(err.status, err.message, headers);
    }
    console.error('[fireflow-api] unhandled error:', err);
    return errorResponse(500, 'サーバー内部でエラーが発生しました。しばらくしてからもう一度お試しください。', extraHeaders);
  }
}
