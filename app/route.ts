// [2026-07-20新設] Live Board本体(1つのHTMLファイルとして作り込まれているPWA)を、
// サイトのルート("/")で表示するためのRoute Handler。
//
// なぜこの形にしたか:
// Live Boardはこれまで、iOS Safariのクセに合わせた無数の細かい修正を積み重ねてきた、
// 単一HTMLファイルの手作りアプリ(public/index.html)である。これをNext.jsのReact
// コンポーネント(app/page.tsx)として作り直すと、書き直しの過程で今まで直してきた
// 挙動を壊すリスクが非常に高い。そのため今回のセキュリティ対応では「フロントエンドは
// 一切書き換えず、公開してはいけないAPIキーまわりだけをNext.jsのRoute Handlerに
// 移す」という方針にした。
//
// public/index.html は、それ単体でも "/index.html" として配信される(Next.jsの
// publicフォルダの標準機能)。ここでは、ブラウザのアドレスバーに表示されるURLが
// これまで通り "/"(ルート)になるよう、同じファイルの中身をそのまま返している。
//
// 【重要】このファイルは app/page.tsx ではなく app/route.ts であるため、
// Reactのレンダリングパイプライン(app/layout.tsx等)を経由しない。返しているのは
// 純粋な静的HTML文字列そのものであり、Next.js側で内容を変換・注入することは一切ない
// (=既存のHTML/CSS/JSはビルド後も1バイトも変わらない)。

import fs from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';
// public/index.html はビルド後に変更されない静的ファイルなので、モジュール読み込み時に
// 一度だけ読んでメモリに保持する(リクエストのたびにディスクI/Oを発生させない)。
const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

export async function GET() {
  return new Response(indexHtml, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
