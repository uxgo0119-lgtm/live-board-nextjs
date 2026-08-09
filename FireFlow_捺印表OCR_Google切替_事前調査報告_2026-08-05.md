# FireFlow 捺印表OCR精度改善 — Google切替 事前調査報告(実装前・ご確認用)

日付: 2026-08-05
対象: 捺印表(点検希望時間連絡票)OCR ─ `TASK_ROUTING['ocr.inspectionSchedule']`
ステータス: **調査のみ完了。コード修正は一切行っていません。** この報告書の内容をご確認いただいた上で、実装方針を決めてから着手します。

---

## 0. 先に結論だけ

1. **「AIプロバイダを切り替えられる仕組み」自体は、実は既に実装済みです。** `TASK_ROUTING`という設定ファイルの値を書き換えるだけで、Anthropic/OpenAI/Geminiを切り替えられる設計に、2026-07-27時点で既になっています(Phase7という過去の作業で導入済み)。ただし現状は「ソースコードの定数」であり、環境変数だけでの切り替えにはなっていません(③で改修案を提示します)。
2. **ただし、GeminiもOpenAIも「実際のAPIキーで一度も接続検証されていません」。** コード内コメントに「実APIキーでのライブ検証未実施」と明記されています。実装だけあってライブ実測ゼロ、という状態です。
3. **さらに別途、Google Cloud Vision API / Document AIの精度比較用ベンチマーク基盤(`lib/ocr-benchmark/`)も過去に作られています。** ただしこちらも「Google Cloud側の認証情報が用意できず、実際のAPI呼び出しによる精度測定は未実施」のまま止まっています。
4. **つまり、このコードベースの中には「Google OCRの方が精度が高かった」という実測データは存在しません。** もし以前どこかで比較結果をご覧になっていたとすれば、それはこのプロジェクトの外(別の検証、または口頭での報告)である可能性があります。念のため、心当たりがあれば教えてください(その情報が「Gemini」なのか「Vision API」なのか「Document AI」なのかで、以降の対応方針が変わります)。
5. **「Google OCR」という言葉には、少なくとも3つの別物の候補技術があります。** どれを比較対象にするかで実装の難易度・期待できる精度傾向・コストが大きく変わるため、1章の最後で整理し、5章で選択をお願いします。

---

## 1. 現在のOCR処理の流れ(①の図解)

対象は捺印表(点検希望時間連絡票)です。実際のコードを追った、現状そのままの流れです。

```
[LBブラウザ]
  ユーザーが捺印表の画像/PDFを選択
        │
        ▼
  ブラウザ側でリサイズ・圧縮 (compressImage)
        │
        ▼
  base64データURL化
        │
        ▼
  fetchStampOcrResult() / fetchStampBulkOcrResult()
  POST /api/scan-time-request
  { mode: 'single'|'bulk', mediaType, data }
  Authorization: Bearer <ログインユーザーのSupabaseトークン>
        │
════════╪═══════════════════════════════════════ ここからサーバー側 ═══
        ▼
[app/api/scan-time-request/route.ts]
        │
        ▼
[lib/handlers/scanInspectionSchedule.ts]
  ① ログイン確認(未ログインなら401)
  ② 利用回数制限チェック(バースト・日次上限)
  ③ mode/mediaType/dataの検証(不正なら400、大きすぎれば413)
        │
        ▼
[lib/ai/capabilities/ocr/documentTypes/residentTimeRequestSheet.ts]
  タスク固有のプロンプト文言・max_tokensを組み立てる
  (「部屋番号・記号・時刻・備考・氏名・日付を読み取って」という指示文)
        │
        ▼
[lib/ai/router.ts] resolveOcrCapability('ocr.inspectionSchedule')
  TASK_ROUTING を見て、どのプロバイダのAdapterを使うか決定
  ※現状は常に 'anthropic' 固定
        │
        ▼
[lib/ai/providers/anthropic/ocr.ts → client.ts]
  Anthropic Messages API (model: claude-sonnet-4-6) を呼び出し
  画像/PDFをbase64のままcontent blockとして送信
        │
        ▼
  応答テキストを受け取る(JSON文字列のはず)
        │
        ▼
  extractJsonFromModelText() でJSONとしてパース
  (bulkモードなら配列であることを追加検証)
        │
        ▼
  { result: [...] } または { result: {...} } をHTTPレスポンスとして返す
════════╪═══════════════════════════════════════ ここからブラウザ側に戻る ═══
        ▼
[LBブラウザ] applyStampSingleOcrResult() / applyStampBulkResult()
  STAMP_DATA[部屋番号] へ保存
  extendRoomRosterFromRoomNumbers() で部屋一覧(FLOORS)へ未登録の部屋を追加
        │
        ▼
  renderFloors() で画面に反映
```

**現状のログの状態(⑤の前提として重要)**: サーバー側はエラー時のみ`console.error`でログが出ますが、成功時の「AIの生テキスト」も「パース後JSON」もログには一切残りません。ブラウザ側もログはなく、失敗時にトースト通知が出るだけです。つまり現状は、精度に問題があっても「どの段階で・どう間違えたか」を後から追う手段がありません。

---

## 2. 「Google OCR」の3つの候補と、それぞれの実現可能性(②)

まず用語を整理させてください。「Google OCR」と一口に言っても、性質の異なる3つの技術があります。

| | A. Gemini(マルチモーダルLLM) | B. Cloud Vision API | C. Document AI |
|---|---|---|---|
| 何をするか | 画像を見て「部屋番号は○○、時刻は○○」とAIが直接JSONで回答する。今のClaudeと全く同じ仕組み | 画像から文字と座標を検出するだけ(意味は理解しない)。検出結果から表構造を組み立てるロジックが別途必要 | Visionに似るが、文書構造の理解に特化。フォームのキー・バリュー抽出に強い(高コスト) |
| 今のClaude実装との互換性 | 高い(同じ「プロンプトを投げてJSONをもらう」方式。差し替えが容易) | 低い(生テキスト+座標→自前のレイアウト解析ロジックが必要) | 低い(同上) |
| このコードベースでの実装状況 | **実装済み**(`lib/ai/providers/gemini/`)。ただし未接続確認 | **ベンチマーク基盤のみ実装済み**(`lib/ocr-benchmark/`)。本番未接続、実測なし | 同上(Document OCRプロセッサのみ対応、Form Parser未対応) |
| このコードベースでの精度実測 | **なし** | **なし** | **なし** |

### A. Gemini(マルチモーダルLLM)への切替

- 実装は既に存在します: `lib/ai/providers/gemini/client.ts`・`ocr.ts`・`index.ts`。Anthropicの実装(`providers/anthropic/`)と全く同じ構造(Adapterパターン)で書かれています。
- 呼び出し方式もAnthropicと同じ「画像を渡してJSON形式で回答するようプロンプトで指示する」方式なので、既存のプロンプト文言(部屋番号・記号・時刻等を読み取る指示)は流用でき、変換コストは低いです。
- **未検証・未確認の点**:
  - 実際のGEMINI_API_KEYでの疎通確認が一度もされていません。
  - 使用予定モデル名 `gemini-2.5-flash` が現行の提供モデル名と一致しているか(Google側のモデル改廃は頻繁です)、精度重視なら`gemini-2.5-pro`の方が良いのではないか、という検討が必要です(4章で提案します)。
  - PDF入力(bulkモード)がGeminiのinlineData形式でそのまま送れるか、公式ドキュメントレベルでは対応していそうですが、このコードベースでは未確認です。
  - `.env.local.example`に`GEMINI_API_KEY`の記載が漏れています(コード自体は対応済みなのに、設定手順のドキュメントが追いついていません)。

### B. Cloud Vision API / C. Document AI への切替

- 2026-07-28〜29に「捺印表OCRの精度比較」を目的として、`lib/ocr-benchmark/`という完全に独立したモジュール一式が作られています。ただしこれは**本番のOCR経路には一切接続されていません**(完了報告書に明記の通り、意図的に未接続)。
- 生の文字+座標を検出するだけのAPIのため、そこから「部屋番号→時刻→記号」という表構造を組み立てる専用パーサー(`stampGridParser.ts`)が別途必要で、実際に1件実装済みです。ただしこのパーサーは**特定の1物件(コスモザ・パークスイースト1)の帳票レイアウトを見て作られたヒューリスティック**であり、管理会社によって捺印表のレイアウトが異なる場合、そのたびに調整が必要になる可能性があります(このプロジェクトが他の業務でも繰り返し経験してきた「管理会社ごとのフォーマット差異」と同種の課題です)。
- Google Cloud側の認証設定(サービスアカウント作成・課金有効化・プロセッサ作成等)が必要で、Vercel環境変数を4つ追加設定する必要があります(手順書は`claude/GoogleCloud_Vision_DocumentAI_セットアップ手順_2026-07-29.md`として既に用意済み)。
- 本番経路(Adapterパターン)へ統合するには、**新規のAdapter実装が必要**です(Vision/DocumentAI呼び出し→`stampGridParser`→既存のJSON形状(`room_number`/`symbol`/`time`等)への変換、をひとまとめにした新しいAdapterをゼロから書く必要があります。現状の`lib/ocr-benchmark/`はこの変換をしていません)。

### 変更箇所・影響範囲(共通)

どちらの方式でも、**LB側のコード(`lb_tool/index.html`)・APIのURL・レスポンス形状には一切影響しません**(Adapterパターンの効果です)。影響が閉じる範囲は以下の通りです。

- **A. Gemini方式**: `lib/ai/config/taskRouting.ts`の1行変更 + `GEMINI_API_KEY`環境変数の設定のみ。既存コードの変更ゼロで切替可能。
- **B/C. Vision/DocumentAI方式**: 新規Adapterファイルの追加(既存ファイルへの変更は`lib/ai/router.ts`への1ケース追加のみ)。ただし新規実装の分量はA方式よりかなり多くなります。

### コスト(2026年8月時点、公式情報から調査)

| プロバイダ/モデル | 入力 | 出力 |
|---|---|---|
| Claude Sonnet(現行 `claude-sonnet-4-6`、Sonnet系の目安) | $2〜3 / 100万トークン | $10〜15 / 100万トークン |
| **Gemini 2.5 Flash**(現行実装のモデル) | **$0.30** / 100万トークン | **$2.50** / 100万トークン |
| Gemini 2.5 Pro(精度重視ならこちらも検討候補) | $1.25 / 100万トークン(20万トークン以下) | $10.00 / 100万トークン(同) |
| Cloud Vision API(documentTextDetection) | 月1,000ユニットまで無料、以降 $1.50 / 1,000ユニット | ─ |
| Document AI(Document OCRプロセッサ) | 無料枠なし、$1.50 / 1,000ページ | ─ |
| Document AI(Form Parserプロセッサ) | 無料枠なし、$30 / 1,000ページ(Document OCRの20倍) | ─ |

画像1枚あたりのトークン数はClaudeの場合「(幅÷28を切り上げ)×(高さ÷28を切り上げ)」という計算式で決まります(例: 1000×1000pxの画像で約1,296トークン)。Geminiも概ね近い水準の画像トークン消費と考えられますが、正確な換算式は今回の調査時間内では公式ドキュメントに具体的な記載が見つかりませんでした(実測で確認するのが確実です)。

**費用面だけで見れば、Gemini 2.5 Flashは現行のClaude Sonnetよりかなり安価です。** ただし今回の最優先事項は「精度」であるとご指示いただいているため、コストは判断の主軸にはしていません(あくまで参考情報です)。

---

## 3. プロバイダ切替の構成案(③)

### 現状

`lib/ai/config/taskRouting.ts`というTypeScriptのソースファイルに、以下のような定数があります。

```ts
export const TASK_ROUTING: Record<TaskName, ProviderName> = {
  'ocr.inspectionSchedule': 'anthropic',
  'ocr.inspectionScheduleSheet': 'anthropic',
};
```

この値を書き換えて再デプロイすれば切り替わる設計に、既になっています。`lib/ai/router.ts`が`ProviderName`(`'anthropic' | 'openai' | 'gemini'`)を見てAdapterを解決する仕組みも完成しています。**つまり「プロバイダを切り替えられる設計」自体は、ご要望の8〜9割は既に実現済みです。**

### 不足している点

ご要望は「環境変数`OCR_PROVIDER`の値を変えるだけで動く」ことです。現状はソースコードの書き換え+再デプロイが必要なため、この差を埋める改修を提案します。

### 改修案(未実装・提案のみ)

```ts
// lib/ai/config/taskRouting.ts (改修イメージ)
const envOverride = process.env.OCR_PROVIDER as ProviderName | undefined;

export const TASK_ROUTING: Record<TaskName, ProviderName> = {
  'ocr.inspectionSchedule': envOverride || 'anthropic',
  'ocr.inspectionScheduleSheet': envOverride || 'anthropic',
};
```

- Vercelの環境変数`OCR_PROVIDER`に `anthropic` / `openai` / `gemini` のいずれかを設定するだけで、再デプロイなしに(正確には環境変数変更時の再デプロイのみで、コード変更は不要)切り替えられるようになります。
- 未設定時は現行通り`anthropic`固定のまま(既存動作に一切影響なし)。
- タスクごとに別プロバイダを使いたい場合(例: 捺印表はGemini、点検予定表はClaudeのまま)は、`OCR_PROVIDER_INSPECTION_SCHEDULE`のようにタスク別の変数名にする案もあります。どちらの粒度が良いか、5章でご確認したい点の一つです。
- Vision/DocumentAI(B/C方式)を将来追加する場合は、`ProviderName`型に`'google-vision'`のような値を追加し、`router.ts`に分岐を1つ足すだけで同じ仕組みに乗ります(型システム上、分岐の追加漏れはコンパイルエラーで検知される設計になっています)。

---

## 4. 同一画像での比較検証の仕組み(④)

### 現状

存在しません。新規に作る必要があります。

### 提案

1. **開発者向け比較エンドポイントの新設**(仮称 `/api/v1/inspection-schedule/scan-compare`)。既存の本番エンドポイント(`/api/scan-time-request`)とは完全に別にします(本番の挙動・レスポンス形状には一切触れません)。同じ画像を、指定された複数プロバイダ(Anthropic/Gemini、必要ならOpenAIも)へ並行してリクエストし、部屋ごとの結果をまとめて返します。
2. **比較用の簡易画面**を用意し(本番ユーザーの目に触れない、開発者・検証担当者向けの位置づけ)、正解値(人が確認した正しい値)を入力すると、以下のような一覧を自動生成します。

   | 部屋 | 正解 | Gemini | Anthropic |
   |---|---|---|---|
   | 101 | 9:00 | ○ | × |
   | 102 | 10:00 | ○ | ○ |
   | 103 | 11:30 | ○ | ○ |
   | 104 | 9:00 | ○ | × |

   一致率(部屋数ベース・項目数ベースの両方)、CSV/Excelへの書き出しも合わせて実装します。
3. `lib/ocr-benchmark/`に既にある「正解データとの一致率計算」ロジック(`computeMatchStats`等、単体テスト済み)は、対象がVision/DocumentAI用に作られたものですが、考え方(正解データとの突き合わせ)は今回の比較機能にも転用できます。ゼロから作るのではなく、この既存資産を土台にする方針を予定しています。

---

## 5. 3段階ログの追加(⑤・最重要)

ご指摘の通り、これが最も重要な部分だと認識しています。現状、精度の問題が「OCR自体が読み取れていない」のか「AIの解析(JSON化)が誤っている」のか「LBへの反映処理でデータが壊れている」のか、切り分ける手段が一切ありません。

### 現状のログ

- サーバー側: 各プロバイダのAdapter(`anthropic/client.ts`等)は、**エラー時のみ**`console.error`でログを出します。成功時、AIの生テキストもパース後JSONも記録されません。
- ブラウザ側: ログなし。失敗時にトースト表示のみ。

### 追加提案(3段階)

| 段階 | 記録する内容 | 記録場所(案) |
|---|---|---|
| ① OCRの生データ | 各Provider Adapter(`anthropic/ocr.ts`・`gemini/ocr.ts`等)が、AIから返ってきた生テキスト(JSONパース前の文字列)を記録 | サーバー側ログ(Vercel Function Logs、または専用ログテーブル) |
| ② AI解析後JSON | パース成功後の配列/オブジェクトをそのまま記録(パース失敗時はその旨とエラー内容も) | 同上 |
| ③ LBへ渡すJSON | ブラウザが受け取った最終ペイロードを、`applyStampBulkResult`/`applyStampSingleOcrResult`に渡す直前で記録 | ブラウザのコンソールログ、または専用の確認画面 |

### 検討していただきたい点

- **保存先**: Vercelのコンソールログは一定期間で消えるため、後から比較検証するには**Supabaseに専用のログテーブルを作る**方が確実だと考えます(捺印表には氏名等の個人情報が含まれるため、保持期間・アクセス権限の設計は別途必要です)。
- **常時ログか、検証モード限定か**: 本番運用で毎回ログを取り続けるか、比較検証をしている期間だけログを厚くする(環境変数でON/OFFできるようにする)か、方針を決めたいです。

---

## 6. まとめ(実装前にご確認いただきたい内容)

### Googleへ切り替える方法(推奨案)

**まずはA方式(Gemini)から着手することを推奨します。** 理由は、既存の実装資産(Adapter)がほぼ完成しており、変更範囲が最小で、最短で実測比較を開始できるためです。Vision/DocumentAI(B/C方式)は、A方式の結果を見てから、必要であれば着手する2段階アプローチを提案します。

### 変更ファイル一覧(実装時の想定)

| ファイル | 変更内容 |
|---|---|
| `lib/ai/config/taskRouting.ts` | 環境変数`OCR_PROVIDER`でのオーバーライドに対応 |
| `.env.local.example` | `GEMINI_API_KEY`の項目を追記(現状漏れています) |
| `lib/ai/providers/anthropic/ocr.ts` / `gemini/ocr.ts` | ①②段階のログ追加 |
| `lb_tool/index.html`(`applyStampBulkResult`等) | ③段階のログ追加 |
| (新規)`app/api/v1/inspection-schedule/scan-compare/route.ts` | 比較検証用エンドポイント |
| (新規)`lib/handlers/scanInspectionScheduleCompare.ts` | 比較検証用の実処理 |
| (新規)比較結果表示用の簡易画面 | 開発者向け、本番UIとは別 |
| (新規、ログ保存先をSupabaseにする場合)`supabase/ocr_debug_log_schema.sql` | ログ用テーブルのマイグレーション |

### リスク・既存機能への影響

- 環境変数`OCR_PROVIDER`が未設定の場合は現行動作(Anthropic固定)のまま変わらないため、**既存の本番機能への影響はありません**。
- Geminiへ実際に切り替えて使う場合、未検証のPDF(bulkモード)対応・モデル名の現行性は、切替前に必ず実データで確認が必要です。
- ログにOCRの生データ・氏名等を記録する場合、個人情報の取り扱い(保持期間・アクセス制御)を検討する必要があります。

### 比較テスト方法(想定手順)

1. `GEMINI_API_KEY`をVercel環境変数に設定。
2. 4章の比較エンドポイントを実装後、実際の捺印表画像(現場で50%程度しか読み取れなかったとされる画像を含む)を、Anthropic・Geminiの両方に投げる。
3. 部屋ごとの結果を正解データと突き合わせ、一致率を算出。
4. 5章のログを見ながら、不一致の原因が「読み取り自体の失敗(OCR)」か「JSON化の失敗(AI解析)」かを切り分ける。
5. 精度・コスト・レイテンシを比較し、採用可否を判断する。

---

## 確認をお願いしたい点

1. **「Google OCR」として比較したいのは、Gemini(LLM方式)ですか、それともCloud Vision API/Document AI(生OCR方式)ですか、あるいは両方ですか。** 2章の通り、実装の難易度も精度の傾向も別物になります。まずGemini(A方式)から着手する案でよいか、ご確認ください。
2. Gemini採用の場合、モデルは現行実装の`gemini-2.5-flash`(高速・低コスト)のままにするか、精度重視で`gemini-2.5-pro`も比較対象に加えるか。
3. `OCR_PROVIDER`は全タスク共通の1つの環境変数にするか、タスクごと(捺印表用/点検予定表用)に分けるか。
4. ログの保存先はVercelログで十分か、Supabaseに専用テーブルを作るか(個人情報を含むため保持期間の方針も)。
5. 「以前Google OCRの方が精度が高い結果が出ていた」というのは、このプロジェクト内の情報でしょうか、それとも別の場での確認結果でしょうか(念のための確認です)。

以上の点をご確認いただき、方針が固まり次第、実装に着手します。
