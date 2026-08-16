# FireFlow コスモザ・パークイースト1 MASTER 94室修正＋新捺印表 実LB監査（2026-08-16）

公開Live Boardで確認された2点だけを扱った。

1. 本来39室のはずが94室になっている
2. 新捺印表JPGが読み込めない

修正はすべて**一般ルール**として書いた。物件名・部屋番号のハードコードは1件も無い。

前提: `docs/FireFlow_コスモザパークイースト1_実ファイル最終監査_2026-08-16.md`（Ground Truth = 立入39戸）
および `docs/FireFlow_コスモザパークイースト1_P0修正_2026-08-16.md`（感知器数.xls から39室MASTERが成立）。

---

## 1. MASTER 94室

### 再現（実ファイル・正式アップロード経路・修正前）

`npx tsx test/trace/repro_parkeast1_master94_2026-08-16.ts`

実ファイル2点を `processDocBatchDraft()`（実アップロード経路）へ投入順どおりに通した実測値:

| 投入順 | 途中 | 最終MASTER | 内訳 |
|---|---|---|---|
| ①点検結果報告書 → ②感知器数.xls | 70室 | **94室** | 70 + 新規24（39室のうち15室は重複） |
| ②感知器数.xls → ①点検結果報告書 | 39室 | **70室** | 正しい39室が70室で丸ごと置換され消滅 |
| ②感知器数.xls のみ | — | 39室 | 正解 |

公開LBの94室と完全一致。ユーザー報告の症状を実コードで再現・確定した。

### FIRST_BREAK

**`public/index.html` `parseExcelAndRebuild()` のRAW段、部屋一覧の構築。**
（修正前 `index.html:9381` の `else` 分岐 = 消火器設置場所テキストへのフォールバック）

### ROOT_CAUSE

点検結果報告書が、**部屋一覧の正本を持たないのに「消火器の設置場所テキスト」から代用の
部屋一覧(70室)を黙って作り、しかも完全成功として表示していた**こと。これが2方向で壊れる。

```
① 報告書が先 : FLOORS = 70室（代用品）
              → 感知器数.xls の正しい39室が applyPropertyMasterIntakeToLb() で
                「追加のみ」マージされ 70 + 39 − 重複15 = 94室
② 報告書が後 : FLOORS = newFloors（無条件の置換）
              → 正しい39室が代用品の70室で上書きされ、24室が消える
```

70室は「多いのに足りない」。立入対象39戸のうち24戸が入っておらず、立入対象でない55室が入る。

### 変更ファイル

| ファイル | 変更 |
|---|---|
| `public/index.html` | `parseExcelAndRebuild()`（MASTERの扱い）／`processDocBatchDraft()`（新捺印表の振り分け）／解析順 |

製品コードはこの1ファイルのみ。新規追加はテストのみ。

### 修正内容（一般ルール）

**点検報告書は、部屋一覧の正本を自分で持つときだけMASTERを作る。持たないときはMASTERを
作らない・増やさない・削らない。**

- 消火器設置場所テキストからの部屋一覧生成（代用品へのフォールバック）を**廃止**した。
  MASTERはExcel由来の正しい住戸一覧を1つだけ持つ、という恒久ルールに戻す。
- 部屋一覧の正本（`自火報（一覧）`シート／感知器の型式内訳シートの部屋番号）を持つ報告書は
  **従来どおり** FLOORS を作り直す。**他物件の正式MASTER経路は1文字も変えていない。**
- 正本を持たない報告書は「既存物件への設備情報の付与」として扱い、
  - 従来はここで `return` して読めた情報を丸ごと捨てていたのをやめ、消火器・前回不良・
    設備一覧・点検日・点検種別・点検者は取り込む（読めた情報は捨てない）
  - 先に取り込んだ感知器個数(SENSOR_MASTER)・点検中データ・予定情報(StampStore)を消さない
  - 物件の同一性（PROPERTY.name）は未設定のときだけ補完する。既存の
    `applyPropertyMasterIntakeToLb()` と同じ既存パターン。**黙って書き換えると予定情報の
    保存スコープ（`currentPropertyScopeKey()` = 物件名）まで変わり、読み取り済みの捺印表が
    画面から消えるため。**
  - 「全N部屋を読み込みました」という成功文言を出さず、部屋一覧を作っていない事実と
    次の操作（感知器個数表または住戸一覧を取り込む）を明示する
- 避難はしごの突合先を「この後LBが持つ部屋一覧」に揃えた（正本を持たない報告書では
  従来 `newFloors` が空で必ず0件になっていた）。

### 結果（実ファイル、修正後）

| 投入順 | MASTER | SENSOR_MASTER | 消火器/前回不良/設備 | 新捺印表39室の照合 |
|---|---|---|---|---|
| 点検結果報告書 → 感知器数.xls | **39室** | 25室 | 78本/1件/8件 | APPLIED 39 / UNMATCHED 0 |
| 感知器数.xls → 点検結果報告書 | **39室** | 25室（消えない） | 78本/1件/8件 | APPLIED 39 / UNMATCHED 0 |
| 感知器数.xls のみ | **39室** | 25室 | — | APPLIED 39 / UNMATCHED 0 |

部屋番号・階構成とも監査で確定した39室と完全一致（不足0・余剰0）。**投入順を変えても増殖しない。**

### 回帰

- `test/unit/lb/inspectionReportMasterPolicy.test.ts`（新設）で、正本を持つ報告書が従来どおり
  FLOORSを作り直すこと・物件入れ替えのリセットが従来どおり走ることを固定した。
- `npm run test:release` の `room_roster_66_to_25_fix_verify` / `sensor_master_p0_p1_verify`
  （内訳シートからの部屋一覧構築＝正本を持つ経路）を含め全PASS。
- `npx tsx test/trace/verify_parkeast1_p0_2026-08-16.ts` ALL PASS。

---

## 2. 新捺印表

実ファイル: `test/fixtures/parkeast1/コスモザパークイースト新捺印表.jpg`
（614,311 bytes / JPEG先頭 `ffd8` / base64長 819,084）

### 正式経路の実測

`npx tsx test/trace/probe_stamp_scan_route_2026-08-16.ts`（dev server 起動中に実測）

| 段 | 結果 |
|---|---|
| UPLOAD_UI | **★BREAK★**（下記。画像1枚を直接選ぶ経路はOK、まとめて追加はLegacyへ） |
| API_ROUTE | OK `/api/v1/standardized-stamp-sheet/scan` 実在。OPTIONS 204 |
| HTTP | OK 401 `{"error":"ログインが必要です。…"}`（JSONで到達）。**413にはならない**（本文819KB） |
| 認証トークン | `scanRequestHeaders()` が Supabase アクセストークンを付与。無効トークンは401 |
| OCR_RAW | ■未確認（実API課金のため無人実行では呼べない） |
| NORMALIZE | ■この画像では未確認／固定ケースは `test:unit` 全PASS |
| CANONICAL | ■この画像では未確認／固定ケースは `test:unit` 全PASS |
| MASTER_MATCH | **OK（前回の破断は解消）** APPLIED 39 / UNMATCHED 0 |
| STAMPSTORE | OK 39件（`applyStampRecordsToLb` → StampStore） |
| SAVE / RESTORE | OK（`stampStorageAdapterRoundTrip` / `stampStore` の各testがPASS） |
| RENDER | OK（`applyStampRecordsToLb` が initScheduleLabels/renderFilterChips/renderFloors を実行） |

### FIRST_BREAK

**UPLOAD_UI の振り分け。同じJPGでも入口によって流れ先が違っていた。**

```
画像1枚を直接選ぶ (routeUnifiedUpload)      → 新OCR /api/v1/standardized-stamp-sheet/scan  ← 正しい
他の資料と一緒に選ぶ／資料をまとめて追加     → Legacy /api/scan-time-request                 ← ★BREAK★
```

### ROOT_CAUSE

`processDocBatchDraft()` の `捺印表` / `希望時間表` 分岐が、画像を**既存Legacyの
`/api/scan-time-request`（1部屋につき1枚の点検希望時間連絡票を読む別様式のOCR）**へ流していた。
A4 1枚に全戸が並ぶ新捺印表を渡しても部屋番号を1つも確定できず、
`applyStampSingleOcrResult()` が `部屋番号を読み取れませんでした。` で失敗する。
さらに同経路は送信前に `compressImage()` で画像を縮小するため、全戸ぶんの細かいマスは
なおさら読めない。

実運用で3点（点検結果報告書・感知器数・新捺印表）をまとめて選ぶと必ずこの経路へ入る。
`index.html:6778` のコメントは「画像1枚は必ず新OCR経路へ入る」と宣言していたが、その保証は
入口が1つの場合しか成立していなかった。

### 修正内容（一般ルール）

1. **振り分けの基準を入口間で一致させた。** `processDocBatchDraft()` でも、捺印表・希望時間表の
   JPG/JPEG/PNGは既存の `isStandardizedStampImageFile()` で判定し、新OCR経路
   （`fetchStandardizedStampScanResult` → `applyStandardizedStampDataToLb`）へ通す。
   原寸のまま送る（縮小しない）。PDF一括・HEICは従来どおりLegacyのまま（既存挙動不変）。
   新しい経路・adapter・canonicalは作っていない。既存の関数を呼ぶ先を揃えただけ。
2. **失敗の理由を黙らせない。** 未反映件数・要確認件数・失敗理由（サーバーの日本語メッセージ）を
   資料一覧の行にそのまま表示する。
3. **応答がJSONでない失敗を日本語にした。** 従来 `await response.json()` が先に例外になり、
   画面に `Unexpected token '<' …` というJavaScriptの生エラーが出ていた。
   504/408（実行時間切れ）・413（容量超過）・その他を日本語で伝える。
4. **まとめて追加したときの解析順を整えた。** 部屋一覧を作りうる資料（点検報告書・住戸一覧・
   感知器個数表）を先に、MASTERへ後から付ける資料（捺印表・希望時間表）を後に処理する。
   逆順だと、正しく読めていても全件が「部屋一覧に無い番号」で未反映になり、
   また部屋一覧を持つ報告書が後から走ると予定情報がリセットされ読み取り結果が消える。
   表示順・保存順・各資料の処理内容は変えていない。

### 未確認区間と、実LBで確認すべき文言（1つに絞る）

**未確認は「この画像に対する実OCRの出力」1点のみ。**実Anthropic APIへの課金呼び出しであり、
無人実行の禁止操作のため実施していない。認証セッションも無いためハンドラは401で終わる。

実LBでは、新捺印表JPGを読み込んだ直後に出る**トースト文言の「◯部屋分」だけ**を見てください。

```
捺印表を読み取りました（39部屋分）。
```

- **39部屋分** → 正常。OCR・MASTER照合・保存まで通っている。
- **0部屋分／「部屋一覧に無い番号◯件は未反映」** → 感知器数.xls を先に読み込んでいない（MASTER未成立）。
- **「読み取りに失敗しました：ログインが必要です…」** → ログインし直しが必要。

---

## 3. テスト結果

| | 結果 |
|---|---|
| unit | **PASS**（`npm run test:unit` 41ファイル全ALL PASS。新設2ファイルを含む） |
| release | **PASS**（`npm run test:release` 5本すべてPASS） |
| typecheck | **PASS**（`tsc --noEmit` エラー0） |
| build | **PASS**（`next build` Compiled successfully / 11ページ生成） |

実ファイル検証:

```
npx tsx test/trace/repro_parkeast1_master94_2026-08-16.ts    # 両順序でMASTER 39室
npx tsx test/trace/verify_parkeast1_p0_2026-08-16.ts         # ALL PASS
npx tsx test/trace/probe_stamp_scan_route_2026-08-16.ts      # 新捺印表の実HTTP実測
npx tsx test/trace/check_index_html_syntax.ts                # インラインJS構文
```

新設したテスト（正式unit、架空の部屋番号のみ・実物件名は不使用）:

- `test/unit/lb/inspectionReportMasterPolicy.test.ts`
- `test/unit/lb/stampSheetUploadRouting.test.ts`

---

## 4. 複雑化確認

| 項目 | 件数 |
|---|---|
| 新Canonical | 0 |
| 新StampStore | 0 |
| 新保存経路 | 0 |
| adapter | 0 |
| override | 0 |
| fallback | **−1（消火器設置場所テキストへのフォールバックを削除）** |
| 物件別ルール | 0 |
| 物件専用処理 | 0 |
| 新フォーマットParser | 0 |
| 新APIエンドポイント | 0 |

---

## 5. 明示した前提（判断が分かれうる箇所）

1. **部屋一覧の正本を持たない点検報告書は、PROPERTY.name を上書きしない**（未設定のときのみ補完）。
   物件名は予定情報の保存スコープキーそのものであり、黙って変えると読み取り済みの捺印表が
   画面から消えるため。結果として、組み込みデモや別物件を表示したまま部屋一覧の無い報告書を
   読み込むと、建物名は変わらず「部屋一覧は現在のN件のまま変更していません」と表示される。
   物件を切り替える正規の操作は既存の「新規物件作成」。
2. 点検結果報告書から39室を復元する処理は追加していない（この帳票に部屋一覧の正本は無い。
   この物件の部屋一覧の正本は感知器数.xls）。
3. `public/fireflow_ingest/dist/` は今回変更していない。

---

## 6. 最終判定

**FIXED（CODE_ONLY / UI_UNVERIFIED）**

- MASTER 94室 … 原因を実ファイルで再現・確定し、修正して39室に確定。投入順を変えても増殖しない。
- 新捺印表 … 最初の破断地点（UPLOAD_UIの振り分けがLegacyへ流れる）を確定し、修正した。
  実OCR出力のみ未確認（無人実行の禁止操作のため）。

絶対ルール11のLOCAL_GOには、実ブラウザでのアップロード操作（実Live Board UI確認）が
残っているため未到達。
