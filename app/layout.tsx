// [2026-07-20新設] 念のための最小限のルートレイアウト。
//
// このプロジェクトは app/page.tsx を1つも持たず(すべて app/**/route.ts のRoute
// Handler、またはサイトルート"/"用の app/route.ts のみ)、Reactのレンダリングを
// 一切行っていない。Route Handlerはこのレイアウトを経由しないため、実際には
// 使われることのないファイルだが、将来Reactページ(app/**/page.tsx)を追加する際に
// 「ルートレイアウトが無い」というビルドエラーで詰まらないよう、あらかじめ最小限の
// ものを置いてある。

import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
