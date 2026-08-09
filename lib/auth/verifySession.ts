// [2026-07-20新設] 「ログイン済みユーザーのみ利用可能」を一箇所に集約する認証チェック。
//
// 以前は api/accept-invite.js と api/scan-time-request.js の両方に、ほぼ同じ
// 「Authorizationヘッダを取り出す→Supabase Auth APIに問い合わせる」処理が
// コピーされていた(コメントにも「api/accept-invite.jsは既にトークン検証していたが、
// こちらは漏れていた」という過去の抜け漏れが記録されている)。今回、この関数一つに
// 集約することで、今後増える新しいRoute Handlerで同じ抜け漏れが起きないようにする。

import { ApiError } from '../http/apiError';
import { verifyAccessTokenAgainstSupabase } from '../supabase/adminClient';

export type VerifiedSession = { userId: string; accessToken: string };

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}

// ログインしていなければ ApiError(401) を投げる。呼び出し側(Route Handler)は
// withErrorHandling でラップしておけば、日本語エラーメッセージがそのままJSONで
// 返る。
export async function requireSession(request: Request): Promise<VerifiedSession> {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    throw new ApiError(401, 'ログインが必要です。ログイン後にもう一度お試しください。');
  }
  const user = await verifyAccessTokenAgainstSupabase(accessToken);
  if (!user) {
    throw new ApiError(
      401,
      'ログイン情報の確認に失敗しました。お手数ですが、もう一度ログインし直してからお試しください。'
    );
  }
  return { userId: user.id, accessToken };
}
