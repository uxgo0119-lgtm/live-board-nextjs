# 捺印表(点検希望時間連絡票)OCR比較検証CLI — `npm run ocr:compare`

[2026-08-05新設] Anthropic(本番)とGeminiへ同一の捺印表画像/PDFを送り、①生レスポンス
②JSON解析後 ③LB取込直前データ の3段階を保持しながら、人間が確認した正解データと
項目別に比較するための開発・検証専用CLIです。

**本番のOCR経路(`/api/scan-time-request`)・LB(`lb_tool`)・RF(`report_flow_tool.html`)・
Parserは一切変更していません。** 本番で使われるプロバイダは引き続きAnthropicのままです
(`lib/ai/config/taskRouting.ts` の既定値は変更していません)。

## 前提条件

- `ANTHROPIC_API_KEY`(実際のキー。既に本番で使っているものと同じでかまいません)
- `GEMINI_API_KEY`(実際のキー。<https://aistudio.google.com/> から取得)
- `SUPABASE_SERVICE_ROLE_KEY`(既存の `lib/config/env.ts` が必須項目としてチェックするため。
  このCLI自体はSupabaseへ一切通信しませんが、ダミー文字列でよいので何か設定してください)

これらを `.env.local` に設定してください(`.env.local.example` を参照)。`npm run dev` 等と
違い、このCLIは `.env.local` を自動読み込みするよう対応済みです(`loadDotEnvLocal.ts`)。

## 使い方

```bash
npm run ocr:compare -- <single|bulk> <画像またはPDFのパス> [正解データJSONパス] [--include-names]
```

- `single`: 1枚の捺印表画像(JPEG/PNG等)
- `bulk`: 複数件を含むPDF
- 正解データJSONパスを省略した場合、認識率の算出はスキップされ、①②③の生データ比較のみ
  行われます(まずは「Anthropicと結果がどう違うか」だけ見たい場合に使えます)。
- `--include-names` を付けない限り、氏名欄はレポート上「伏字」になります(最重要方針9)。

## 正解データ(ground truth)JSONの形式

`lib/ocr-benchmark/types.ts` の `StampSheetEntry[]` と同じ形式です(既存のOCRベンチマーク
ツールと相互運用可能)。**人間が実際の原紙(捺印表そのもの)を見て作成してください。
AIの出力を正解データとして使ってはいけません(最重要方針5)。**

```json
[
  { "room_number": "101", "symbol": "A", "time": "", "time_end": "", "note": "", "name": "", "date": "" },
  { "room_number": "102", "symbol": "", "time": "13:00", "time_end": "14:00", "note": "", "name": "", "date": "7/25(土)" },
  { "room_number": "103", "symbol": "キャンセル", "time": "", "time_end": "", "note": "", "name": "", "date": "" }
]
```

- `symbol`: `'A'`(午前)、`'P'`(午後)、`'キャンセル'`、または空文字(時間指定 or 未回答)
- `time`/`time_end`: 時間指定の場合のみ(symbolがある行では空文字)
- `date`: 用紙に書かれた日付の原文まま(例: `'25(土)'`)。**scheduleDate/scheduleDayへの
  正規化(何年何月かの補完)はこのCLIでは行いません**(下記「既知の制約」を参照)。

## 出力

`ocr-compare-reports/` 配下に、実行ごとに以下の2ファイルを書き出します(`.gitignore`済み)。

- `<入力ファイル名>.<タイムスタンプ>.json` — 機械可読なレポート全体(氏名は伏字化済み)
- `<入力ファイル名>.<タイムスタンプ>.html` — ブラウザで開くと部屋ごとの横並び比較表
  (Anthropic / Gemini / 正解)が見られる、自己完結型の静的HTML

いずれも**このCLIを実行したローカル環境にのみ**書き出され、どこにもアップロード・
デプロイされません。

## トレーサビリティ(①②③)について

- ①生データ: Anthropic Messages API / Gemini generateContent API から返ってきた
  パース前のテキストそのもの
- ②JSON解析後: ①を `extractJsonFromModelText`(本番と同じ関数)でパースした結果
- ③LB取込直前データ: `lb_tool/index.html` の `applyStampSingleOcrResult`/
  `applyStampBulkResult` のフィールド正規化ロジックをNode側へ移植したもの
  (symbolを3値+空文字に丸める、symbolがあればtime/time_endを強制的に空文字にする、等)

①→②→③のどこかでOCR結果が正解データと食い違っている場合、このレポートを見れば
「AIの読み取り自体が間違っていたのか(①②)」「正規化処理側の問題なのか(③)」を
切り分けられます。

## 既知の制約(意図的に未実装)

- **日付の年月補完**: LB側の `resolveStampScheduleDate()`/`normalizeStampDateRaw()` は、
  その物件に登録済みの点検実施日一覧(`PROPERTY.scheduleDays`、ブラウザの実行時状態)を
  参照して「25」という数字だけの記入から年月日を推測します。この状態は物件非依存の
  スタンドアロンCLIでは再現できないため、date欄は原文のまま(dateRaw)保持し、
  年月日への正規化は行いません。誤った正規化ロジックを重複実装してLB側の実装と
  ズレるリスクを避けるための意図的な判断です。
- **「第一希望・第二希望」欄**: 現行の捺印表OCRの出力形式(room_number/symbol/time/
  time_end/note/name/date)には存在しない項目です。該当欄がある帳票の場合は
  別途ご相談ください。

## 実測についての重要な注意

このCLIが出力する数値は、**実行時に実際にAPIへ到達できた場合に限り実測値です。**
`ANTHROPIC_API_KEY`/`GEMINI_API_KEY` が未設定、またはAPI呼び出しに失敗した場合、
レポート上は「未検証」「実API呼び出し失敗」と明示されます。この場合の数値を
「精度検証済み」として扱わないでください。

このリポジトリの開発環境(サンドボックス)には実際のAPIキー・外部ネットワーク疎通が
無いため、実装側では「モックデータでの動作確認」までしか行っていません。**実際の
コスモ茨木穂積等の現場データでの比較は、実キーを設定した環境でこのCLIを実行して
初めて得られます。**
