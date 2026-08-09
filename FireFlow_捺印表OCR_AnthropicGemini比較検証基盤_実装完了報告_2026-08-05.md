# FireFlow 捺印表OCR Anthropic／Gemini比較検証基盤 実装完了報告
2026-08-05

## 0. 結論サマリー

事前報告どおり、**本番のOCR経路(Anthropic)・LB・RF・Parserには一切手を加えず**、
`lib/ocr-compare/` という新規ディレクトリに、開発・検証専用のCLIツール
(`npm run ocr:compare`)を追加した。

**このサンドボックス環境には実際の`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`が無いため、
実測での精度比較は行えていない。** 実装したロジック(JSON解析・LB用正規化・正解データとの
項目別比較・存在しない部屋の追加/欠落の分離集計)はすべてオフラインの単体テストで
動作確認済みだが、これは「実APIから実際に返ってくる応答形式が本当にこの通りか」までは
検証していない。「実測」と呼べる結果を得るには、実キーを設定した環境(お使いのMac等)で
`npm run ocr:compare` を実行していただく必要がある(手順は下記4章)。

## 1. 実装したもの(ファイル一覧)

### 新規作成

| ファイル | 内容 |
|---|---|
| `lib/ocr-compare/types.ts` | 共通型定義(①②③の3段階、比較結果、集計サマリー) |
| `lib/ocr-compare/runProviders.ts` | Anthropic/Geminiの低レベルクライアント(既存・無改修)を直接呼び出し、①raw→②parsedを構築 |
| `lib/ocr-compare/normalizeToLbFormat.ts` | ③LB取込直前データへの正規化(`lb_tool/index.html`のロジックをNode側へ移植) |
| `lib/ocr-compare/compareToGroundTruth.ts` | 正解データとの項目別比較。欠落/存在しない部屋の追加を別集計、午前午後/キャンセル/空欄別の一致率算出 |
| `lib/ocr-compare/groundTruth.ts` | 正解データJSON読み込み |
| `lib/ocr-compare/redact.ts` | 氏名の伏字化(最重要方針9対応) |
| `lib/ocr-compare/htmlReport.ts` | 部屋ごと横並び比較のHTMLレポート生成(要望のあった「比較しやすいUI」) |
| `lib/ocr-compare/loadDotEnvLocal.ts` | `.env.local`読み込み(依存追加なし) |
| `lib/ocr-compare/runCompare.ts` | CLI本体(`npm run ocr:compare`) |
| `lib/ocr-compare/README.md` | 使い方・正解データ形式・既知の制約・実測についての注意 |
| `test/unit/ocr-compare/*.test.ts` (5ファイル) | オフライン単体テスト |
| `test/unit/ai/config/taskRouting.test.ts` | env var切替の単体テスト |

### 変更(すべて追記のみ。既存の値・挙動は変更していない)

| ファイル | 変更内容 |
|---|---|
| `lib/ai/config/taskRouting.ts` | `resolveProviderForTask()`を追加。タスク別env var(`OCR_PROVIDER_INSPECTION_SCHEDULE`等)が未設定なら、これまで通りTASK_ROUTINGの既定値(anthropic)を使う |
| `lib/ai/router.ts` | `TASK_ROUTING`直接参照 → `resolveProviderForTask()`経由に変更(1行) |
| `lib/ai/capabilities/ocr/documentTypes/residentTimeRequestSheet.ts` | `SINGLE_PROMPT`/`BULK_PROMPT`/`SINGLE_MAX_TOKENS`/`BULK_MAX_TOKENS`を`export`に変更(値は無変更。比較CLIが本番と同じプロンプトを重複実装せず再利用するため) |
| `.env.local.example` | 未記載だった`GEMINI_API_KEY`と新設env varを追記 |
| `.gitignore` | `/ocr-compare-reports/`を追加 |
| `package.json` | `"ocr:compare": "tsx lib/ocr-compare/runCompare.ts"`を追加 |

**本番のRoute Handler(`app/api/**`)・`lb_tool`・`report_flow_tool.html`・Parser関連コードは
1バイトも変更していない。**

## 2. 最重要方針への対応状況

| # | 方針 | 対応 |
|---|---|---|
| 1 | Anthropic本番動作を維持 | `TASK_ROUTING`既定値は無変更。env var未設定なら本番挙動は今まで通り |
| 2 | Geminiを既定値にしない | 同上。env varで明示的に上書きしない限りGeminiは使われない |
| 3 | 比較機能は本番と分離 | 本番のRoute Handler・UIには一切追加せず、独立したCLI(`npm run ocr:compare`)として実装 |
| 4 | 同じ画像を3モデルへ(今回はAnthropic/Geminiの2モデル) | 同一base64データを両方へ並行送信。出力は共通の`LbNormalizedEntry`形式に正規化 |
| 5 | 正解データは人間確認のみ、AI多数決なし | 正解データはJSONファイルとして人間が用意する前提。AIの出力同士を突き合わせて「正解」とするロジックは実装していない |
| 6 | 項目別比較(部屋番号だけでなく) | symbol・time・time_end・note・name・dateを個別に比較 |
| 7 | 存在しない部屋の追加と欠落を別々に計測 | `computePhantomRooms()`(追加)と、既存`lib/ocr-benchmark/failureAnalysis.ts`の`missed_value`判定(欠落)を別カウント |
| 8 | ①②③のトレーサビリティ | `ProviderRunResult`が`stage1Raw`/`stage2Parsed`/`stage3Lb`を保持。HTMLレポートにも3段階すべて出力 |
| 9 | 個人情報を無制限に保存しない | レポート出力(JSON/HTML)は既定で氏名を伏字化。`--include-names`で明示オプトインした場合のみ実名を出力。サーバー側DB保存は行わず、ローカルファイルのみ |
| 10 | 未検証を「確認済み」と報告しない | 下記3章参照。本報告書でも実測と未検証を明確に分けて記載している |

「第一希望／第二希望」欄は、現行の捺印表OCR出力形式に存在しないため実装していない
(1章の事前報告時点でお伝えした通り。別帳票であれば追加対応が必要)。

## 3. 検証状況(実施済み/未実施を明確に区別)

### 実施済み(このサンドボックス環境で確認できたこと)

- オフライン単体テスト: 新規6ファイル + 既存14ファイル、**全20ファイルPASS**(実APIへは一切通信していない)
  - 本番プロンプト(`SINGLE_PROMPT`/`BULK_PROMPT`)・`SINGLE_MAX_TOKENS`/`BULK_MAX_TOKENS`を比較CLIが重複実装せず本番と完全一致した値で使っていることを確認
  - LB用正規化ロジック(`applyStampSingleOcrResult`/`applyStampBulkResult`の移植)が、symbol制限・time強制空文字化・trim等、既存ロジックと同じ挙動になることを確認
  - 「欠落」と「存在しない部屋の追加」が別々に集計されること、午前午後/キャンセル/空欄限定の一致率計算が正しいことを、手作業で作った具体例で確認
  - 氏名が既定でレポートに一切残らないこと(シリアライズした文字列に実名が含まれないこと)を確認
- 型チェック: このサンドボックスにはネットワーク制限で`next`/`@types/react`等をインストールできず、`npm install`は完走できなかった(Thread A時点から変わらない既知の制約で、本番ビルド自体はいつもお使いのMac側で確認いただいている)。代替として、グローバルにあるTypeScriptコンパイラで`lib/ai/`・`lib/ocr-compare/`配下のみを対象にした型チェックを実施し、**今回追加・変更したファイルに起因する型エラーは0件**であることを確認した(検出された8件のエラーはすべて`next`/`@types/react`未インストールという、今回の変更と無関係な既存の環境制約によるもの)。

### 未実施(実際のお手元の環境で確認が必要なこと)

- **Anthropic/Gemini実APIへの実疎通確認は行っていない**(実キー・実ネットワークが無いため)。
- **コスモ茨木穂積等、実際の捺印表データでの精度比較は行っていない。**
- したがって、「Geminiの方が精度が高い/低い」という結論は、この報告書のどこにも
  記載していない(最重要方針10)。

## 4. 実測を行うための手順(お手元の環境で)

1. このzipを展開し、`.env.local`に`ANTHROPIC_API_KEY`・`GEMINI_API_KEY`・
   `SUPABASE_SERVICE_ROLE_KEY`(既存のものと同じでよい)を設定する
   (`.env.local.example`参照)。
2. `npm install`
3. `npm run test:unit`(念のため、お手元の環境でも全PASSすることを確認)
4. 正解データJSONを用意する(`lib/ocr-compare/README.md`の形式を参照。実際にコスモ茨木穂積の
   捺印表原紙を見ながら、部屋ごとの正しい値を手入力していただく必要がある)。
5. 捺印表の画像/PDFファイルを用意する。
6. 実行:
   ```bash
   npm run ocr:compare -- single ./捺印表.jpg ./ground-truth.json
   ```
7. `ocr-compare-reports/`配下に出力されるHTMLファイルをブラウザで開くと、部屋ごとの
   Anthropic/Gemini/正解の横並び比較表が見られる。

## 5. 今後の選択肢(判断が必要な場合のみ)

- 今回はGemini 2.5 Flash(本番のGeminiプロバイダと同じモデル)のみを比較対象とした。
  Gemini 2.5 Proや将来のOpenAIも含めて比較したい場合は、`runProviders.ts`の対応拡張は
  比較的小さな変更で可能(本番のTASK_ROUTING・既存Adapterには影響しない)。
- 実測の結果、Geminiの方が明らかに精度が高いことが分かった場合、`TASK_ROUTING`の値を
  `'gemini'`に変更するだけで本番切り替えが可能(ただし最重要方針2により、これは
  ユーザーの明示的な指示があった場合のみ実施する)。
