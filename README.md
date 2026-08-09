# fireflow-api（Live Board / Report Flow 共通バックエンド）

2026-07-20、Live Board の本番運用を見据えたセキュリティ対応として新設したプロジェクトです。
Next.js App Router の Route Handler（`app/api/**/route.ts`）を使って、これまで
ブラウザから直接見えていた（あるいは見えるリスクがあった）APIキーまわりの処理を
すべてサーバー側に隔離しています。

## これは何をするプロジェクトか

- Live Board 本体（`public/index.html`）と招待受け入れページ（`public/join.html`）を、
  これまでどおり**1つのHTMLファイルのまま**配信します（Reactへの書き換えは一切していません）。
- `ANTHROPIC_API_KEY` を使う「点検希望時間連絡票のAIスキャン(OCR)」と、
  `SUPABASE_SERVICE_ROLE_KEY` を使う「招待リンクの受け入れ」処理を、
  Next.js の Route Handler として実行します。
- 上記2つの秘密鍵は、Vercelの環境変数（`.env.local` はローカル開発用）にのみ置かれ、
  ブラウザに配信されるコード（`public/` 配下）には一切含まれません。

## 全体構成

```
ブラウザ (Live Board / public/index.html)
   │  fetch('/api/scan-time-request' または '/api/v1/inspection-schedule/scan')
   │  Authorization: Bearer <ログイン中ユーザーのSupabaseアクセストークン>
   ▼
Next.js Route Handler (app/api/**/route.ts)  ← このプロジェクト。ANTHROPIC_API_KEY等はここだけが保持
   │
   ├─ ① ログイン確認 (lib/auth/verifySession.ts → Supabase Auth API)
   ├─ ② 利用回数制限 (lib/rateLimit/checkUsage.ts → Supabase上のPostgres関数)
   └─ ③ AI呼び出し (lib/ai/capabilities/ocr/... → lib/ai/router.ts → lib/ai/providers/anthropic/... → Anthropic API)
```

### AIプロバイダ非依存化（2026-07-20 改訂）

「Claude専用アプリ」ではなく、「FireFlow」というサービスとしてAIプロバイダを自由に
入れ替えられるように、`lib/ai/` を以下の3層に分けています（現時点ではAnthropicの
実装のみ。将来OpenAI・Geminiを追加しやすい構造だけ先に整備したもので、機能自体は
変更していません）。

```
lib/handlers/scanInspectionSchedule.ts   … Route Handlerの実処理
   │  呼ぶのは「タスク固有の関数」のみ(プロバイダ名は知らない)
   ▼
lib/ai/capabilities/ocr/inspectionSchedule.ts   … プロンプト文言・入力サイズ上限などのタスク固有知識
   │  呼ぶのは「タスク名」のみ(例: 'ocr.inspectionSchedule')
   ▼
lib/ai/router.ts (Task Router)   … lib/ai/config/taskRouting.ts の対応表を見てプロバイダを解決
   │
   ▼
lib/ai/providers/anthropic/{client.ts, ocr.ts}   … Anthropicとの実際の通信(Adapter)
   │
   ▼
Anthropic API (Claude)
```

将来OpenAI・Geminiを追加する場合、変更が必要なのは次の3箇所だけです（`lib/handlers/`・
`app/api/**`・フロントエンドは無変更で済みます）。

1. `lib/ai/providers/openai/`（または`gemini/`）に、Anthropic版と同じ形の
   `OcrCapability` 実装を追加する。
2. `lib/ai/config/taskRouting.ts` の `ProviderName` に新しいプロバイダ名を追加し、
   該当タスクの値を書き換える（用途ごとにAIを切り替えたい場合は、タスクを
   `ocr.inspectionSchedule` 以外にも増やし、それぞれ別のプロバイダを指定できます）。
3. `lib/ai/router.ts` の `switch` に1ケース追加する。

## フォルダ構成（将来100社以上での運用を見据えた設計）

```
app/
  route.ts                          … サイトルート"/"でLive Boardを表示
  layout.tsx                        … 最小限のルートレイアウト(Route Handlerのみのため実質未使用)
  api/
    v1/                             … 今後の正式なエンドポイント(新規の呼び出しはすべてこちらを使う)
      health/route.ts               … 死活監視用(認証不要)
      inspection-schedule/
        scan/route.ts               … 点検希望時間連絡票のAIスキャン(OCR)
      invites/
        route.ts                    … 招待リンクの確認(GET、ログイン不要)
        accept/route.ts             … 招待の受け入れ(POST、ログイン必須)
    accept-invite/route.ts          … 旧URLの後方互換エイリアス(中身はv1と共通)
    scan-time-request/route.ts      … 旧URLの後方互換エイリアス(中身はv1と共通)
lib/
  config/env.ts                     … 環境変数の一元管理(サーバー専用)
  auth/verifySession.ts             … ログイン確認の一元化
  rateLimit/checkUsage.ts           … 利用回数制限の一元化
  supabase/adminClient.ts           … Supabase REST/Auth APIへの薄いラッパー
  ai/
    types.ts                        … プロバイダ非依存の共通型(OcrCapability等の「ポート」定義)
    router.ts                       … Task Router: タスク名→プロバイダの解決
    shared/extractJsonFromModelText.ts … モデル応答からのJSON抽出(プロバイダ非依存の共通処理)
    config/taskRouting.ts           … タスク→プロバイダの対応表(将来ここを書き換えるだけで切替可能)
    capabilities/
      ocr/inspectionSchedule.ts     … 「点検希望時間連絡票OCR」のプロンプト・入力検証(タスク固有知識)
    providers/
      anthropic/{client.ts, ocr.ts, index.ts}  … Anthropic Adapter(実装済み)
      openai/, gemini/ …             … 【将来追加】同じ形でAdapterを追加するだけで拡張できる
  invites/inviteService.ts          … 招待リンクのビジネスロジック
  handlers/                         … 新URL・旧URL両方から呼ばれる実処理(重複を避けるため1箇所に集約)
  http/apiError.ts, errors.ts, cors.ts
public/
  index.html, join.html, supabase-integration.js  … 既存のフロントエンドをそのまま配置
supabase/
  schema.sql                        … 既存スキーマ(参照用にコピー)
  rate_limit_schema.sql             … 【要実行】利用回数制限用の新規テーブル・関数
test/unit/                          … サーバー側ロジックの単体テスト(next不要、tsxで実行可能)
  ai/capabilities/, ai/providers/anthropic/, ai/router.test.ts … AI層の単体テスト
```

新しい機能（別の顧客企業向けのAPI、新しいAI機能など）を追加する際は、
`app/api/v1/<新機能>/route.ts` を追加し、実処理は `lib/` 配下に置く、という同じパターンを
繰り返してください。認証・レート制限・CORSは既存の `lib/auth`・`lib/rateLimit`・`lib/http/cors`
をそのまま再利用できます。

## デプロイ手順

1. **Supabaseの追加設定**: `supabase/rate_limit_schema.sql` の内容を、Supabaseダッシュボードの
   SQL Editor で実行してください（既存のテーブルには影響しません。新しいテーブルと関数を
   1つずつ追加するだけです）。
2. **Vercelへのデプロイ**: このディレクトリを新しいVercelプロジェクトとしてデプロイしてください
   （Next.jsは自動検出されるため、追加設定は不要です）。
3. **環境変数の設定**: Vercelのプロジェクト設定 → Environment Variables で、
   `.env.local.example` に記載の変数（`ANTHROPIC_API_KEY`・`SUPABASE_SERVICE_ROLE_KEY`・
   `ALLOWED_ORIGINS` など）を設定してください。**`ALLOWED_ORIGINS` は本番URLが確定してから
   必ず設定してください**（未設定のままだと全オリジンを許可する開発モードのままになります）。
4. **旧プロジェクト(`vercel-project`)の扱い**: 招待受け入れ・AIスキャンのAPIキーが
   このプロジェクトに一本化されたため、旧`vercel-project`(素のVercel Functions版)は
   このプロジェクトへの切り替え後、順次廃止することを推奨します(切り替え直後は
   並行稼働させても問題ありません。URLの構造・レスポンス形式は完全互換です)。

## デプロイ後に必ず確認してほしいこと

**このサンドボックス環境ではnpmレジストリへのアクセスが許可されておらず、
`npm install` や `next build` を実行して動作確認することができませんでした。**
コード自体は Next.js App Router の標準的な書き方に沿って手作業で作成し、
`tsc`(TypeScript コンパイラ)による型チェックと、Next.js に依存しないロジック部分
(認証・レート制限・招待ロジック・AI呼び出しの組み立て)についてはモックを使った
単体テスト(`test/unit/`, 全9ファイルPASS済み)で検証していますが、実際に
`next build` を通した確認ができていません。デプロイ前に、以下を必ず確認してください。

1. `npm install` → `npm run build` がエラーなく完了すること。
2. `npm run typecheck`(`tsc --noEmit`)がエラーなく完了すること。
3. `npm run test:unit` が全てPASSすること。
4. デプロイ後、`https://<デプロイURL>/` にアクセスし、これまでどおりLive Boardの
   画面が表示されること(サイトルートの表示は `app/route.ts` が `public/index.html` を
   読み込んで返す方式にしています。万が一表示されない場合は、`next.config.js` の
   `outputFileTracingIncludes` の設定を確認してください)。
5. `https://<デプロイURL>/api/v1/health` にアクセスし、`{"ok":true,...}` が返ること。
6. 実際にLive Boardから点検希望時間連絡票をアップロードし、これまでどおりOCRが
   動作すること(ログイン状態で)。
7. ブラウザの開発者ツール(Network・Sources)で、`ANTHROPIC_API_KEY` や
   `SUPABASE_SERVICE_ROLE_KEY` の値がどこにも表示されないこと
   (`test/unit/noSecretsInPublic.test.ts` で `public/` フォルダ自体は機械的に
   確認済みですが、実際にブラウザで開いて目視確認することも推奨します)。

## セキュリティ上の設計判断・既知の制約

- **CORSは主な防壁ではありません。** 主な防壁は Bearer トークンによるログイン確認と
  利用回数制限です。CORS(`ALLOWED_ORIGINS`)は、ブラウザ経由の不正利用に対する
  多層防御の一枚として設定してください。
- **レート制限はSupabase(Postgres関数)ベースです。** Upstash/Redis等を使う実装より
  レイテンシはやや大きいですが、新しい外部サービスへの契約・環境変数追加が不要で、
  今日から使える構成にしました。将来、極めて高頻度のアクセスが見込まれる場合は
  Redis/Upstashベースの実装へ差し替えを検討してください(`lib/rateLimit/checkUsage.ts`の
  インターフェースは変えずに中身だけ差し替えられる設計にしてあります)。
- **`/api/accept-invite`・`/api/scan-time-request`(旧URL)は後方互換のために残しています。**
  中身は `/api/v1/...`(新URL)と完全に同じ実装を共有しているため、二重管理にはなりません。

