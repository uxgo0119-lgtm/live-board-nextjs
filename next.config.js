/** @type {import('next').NextConfig} */
const nextConfig = {
  // [2026-07-20新設] app/route.ts (サイトルート"/")が public/index.html を
  // fs.readFileSync で読み込んでいるため、Vercelへのデプロイ時にそのファイルが
  // サーバーレス関数の実行環境に確実に含まれるよう、明示的にファイルトレースの
  // 対象へ追加している。省略しても多くの場合は動くとされる(process.cwd() +
  // 文字列リテラルのpath.joinはVercelの自動ファイルトレーサーが認識できることが
  // 多いため)が、「見えるはずのファイルが本番でだけ見つからない」という事故を
  // 避けるため、念のため明示している。
  // [2026-08-05修正] Next.js 14系では outputFileTracingIncludes はまだ実験的機能のため
  // experimental の中に書く必要がある(トップレベル直書きだと"Unrecognized key(s)"警告が出て
  // 黙って無視されてしまい、この設定自体が効かなくなっていた)。
  experimental: {
    outputFileTracingIncludes: {
      '/': ['./public/index.html'],
    },
  },
};

module.exports = nextConfig;
