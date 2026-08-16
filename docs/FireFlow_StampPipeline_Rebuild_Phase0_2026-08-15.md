# FireFlow 新捺印表パイプライン再構築 Phase 0：現状監査・新アーキテクチャ設計

作成日：2026-08-15
対象：`~/FireFlow/live-board-nextjs`（Macローカル実コードを正本として調査）
範囲：設計監査のみ。本体再構築の実装は未着手。commit/push/deployなし。

調査で新たに実行したのは実コードの読み取り・検索のみ。既に確定済みの事実（実画像1枚のOCR結果、
実LB1回分の診断ログ）は再取得せず、そのまま根拠として使用している。

---

## 1. 現状パイプライン図

### 1-A. 新捺印表（Standardized / New OCR）— 現在の実経路

```
実画像(JPG/PNG 1枚)
  │  #uploadChoiceUnified → #unifiedUploadInput(change)
  ▼
routeUnifiedUpload(files)                         public/index.html:6600付近
  │  画像1枚のみ → 新経路 / それ以外 → 既存の資料取込(=Legacy経路。§6)
  ▼
runStandardizedStampScan(dataUrl)                 public/index.html
  ▼
fetchStandardizedStampScanResult(dataUrl)
  │  POST /api/v1/standardized-stamp-sheet/scan (Bearer=Supabaseアクセストークン)
  ▼
app/api/v1/standardized-stamp-sheet/scan/route.ts
  ▼
lib/handlers/scanStandardizedStampSheet.ts
  ├─ requireSession → enforceRateLimit → validateOcrPayload
  ├─ scanStandardizedStampSheet()   lib/ai/capabilities/ocr/documentTypes/standardizedStampSheet.ts
  │     └─ Anthropic(taskRouting) → {rooms[], time_designation_rows[], qr_code_raw}
  ├─ normalizeStandardizedStampScan()  lib/ocr/standardizedStampSheet/normalizeStandardizedStamp.ts
  │     ├─ parseRawScanResult.ts       生JSON→型付きraw
  │     ├─ symbolConvergence.ts        A/P/キャンセル（複数チェックは収束させない）
  │     ├─ gridTimeParser.ts           1マス1文字の時刻確定（推測補完しない）
  │     ├─ misreadDictionary.ts        ★FireFlow辞書（正規語＋誤読辞書）
  │     └─ timeDesignation.ts          時間指定行→部屋への結合（行自身の部屋番号マスのみ）
  └─ toLiveBoardStampData()            lib/ocr/standardizedStampSheet/toLiveBoardStampData.ts
        └─ {stampData, needsReviewRooms, skippedRooms, unassignedTimeDesignationRowCount}
  ▼ (HTTP応答)
clearDemoStampDataForPropertyChange()   ← メモリのSTAMP_DATAを全消去
applyStandardizedStampDataToLb(stampData)  public/index.html
  ├─ FLOORS(=MASTER)に在る部屋だけへ STAMP_DATA[room] = {...} （形式変換あり：time_start→time）
  ├─ stampScannedRooms[room] = 同じ実体
  ├─ storageSet('fireflow-stamp:'+room, JSON) …IndexedDB即時 + Supabase kv_store(+outbox再送)
  └─ initScheduleLabels() → renderFilterChips() → renderFloors()
  ▼
scheduleLabels[room] = {text, color, timeDisplay}   ← 表示用に再構成
  ▼
renderFloors() → effectiveScheduleLabel(room)（scheduleOverridesが有ればそれで上書き）
  ▼
部屋カードHTML（A/P、時刻、備考、要確認バッジ）
```

### 1-B. ページ再読込時（復元）

```
起動ゲート initPropertyStartupGate()
  ├─「前回の物件を続ける」→ applyCurrentPropertyRecord(record)
  │      ├─ clearDemoStampDataForPropertyChange()  ← STAMP_DATA = {}
  │      ├─ PROPERTY/FLOORS/SENSOR_MASTER… を復元（STAMP_DATAは含まれない）
  │      └─ restoreStampDataFromStorage()   ※awaitされない fire-and-forget
  │             └─ storageList('fireflow-stamp:') → storageGet → STAMP_DATA[room]
  ├─「新規物件を作成」→ createNewProperty()（復元しない）
  └─「デモを開く」   → seedDemoState()（復元しない）
```

---

## 2. 実際のファイル / 関数一覧

| # | 段階 | ファイル | 関数 | 入力 | 出力 | 保存先 | 次の呼び出し先 |
|---|---|---|---|---|---|---|---|
| 1 | UI入口 | public/index.html | `routeUnifiedUpload` | File[] | 分岐 | なし | `runStandardizedStampScan` / `openDocBatchUploadDialog` |
| 2 | 送信 | public/index.html | `fetchStandardizedStampScanResult` | dataURL | API result | なし | fetch |
| 3 | Route | app/api/v1/standardized-stamp-sheet/scan/route.ts | `POST` | Request | Response | なし | handler |
| 4 | Handler | lib/handlers/scanStandardizedStampSheet.ts | `handleStandardizedStampScanRequest` | body | JSON | なし | OCR→normalize→変換 |
| 5 | OCR | lib/ai/capabilities/ocr/documentTypes/standardizedStampSheet.ts | `scanStandardizedStampSheet` | base64 | rooms/time_rows/qr | なし | lib/ai/router |
| 6 | 生解釈 | lib/ocr/standardizedStampSheet/parseRawScanResult.ts | `parseRawScanRooms` / `parseTimeDesignationRawRows` | unknown[] | 型付きraw | なし | normalize |
| 7 | 記号 | 〃 symbolConvergence.ts | `convergeSymbol` | raw_checkboxes | ResolvedSymbol | なし | normalize |
| 8 | 時刻 | 〃 gridTimeParser.ts | `parseGridTimeCells` | cells[] | GridTimeReadResult | なし | timeDesignation |
| 9 | **辞書** | 〃 misreadDictionary.ts | `matchAgainstDictionaries` | 備考原文 | MisreadMatch | なし | timeDesignation / normalize |
| 10 | 結合 | 〃 timeDesignation.ts | `joinTimeDesignationRows` | entries + rawRows | rows/unassigned（entriesを破壊的更新） | なし | normalize |
| 11 | 正規化 | 〃 normalizeStandardizedStamp.ts | `normalizeStandardizedStampScan` | scan | NormalizedResult | なし | 変換 |
| 12 | LB変換 | 〃 toLiveBoardStampData.ts | `toLiveBoardStampData` | NormalizedResult | `LiveBoardStampEntry`辞書 | なし | HTTP応答 |
| 13 | 反映 | public/index.html | `applyStandardizedStampDataToLb` | stampData | applied/unmatched | **STAMP_DATA / stampScannedRooms / kv_store** | initScheduleLabels |
| 14 | 表示計算 | public/index.html | `initScheduleLabels` | STAMP_DATA | scheduleLabels | なし | renderFloors |
| 15 | 描画 | public/index.html | `renderFloors` | FLOORS+STAMP_DATA+scheduleLabels+scheduleOverrides+state | HTML | なし | DOM |
| 16 | 復元 | public/index.html | `restoreStampDataFromStorage` | kv_store | STAMP_DATA | なし | renderFloors |
| 17 | 保存層 | public/index.html | `storageSet/Get/Delete/List` | key,value | – | IndexedDB(cache/outbox) + window.storage | supabase-integration.js |
| 18 | 保存層(実体) | public/supabase-integration.js | `storage.set/get/list/delete` | – | – | Supabase `kv_store` | – |

---

## 3. 現在存在する「正本候補」

同じ「部屋の点検予定情報（記号・時刻・備考）」を保持している場所：

| # | 名前 | 実体 | 寿命 | 形式 |
|---|---|---|---|---|
| 1 | OCR raw | サーバー内一時 | リクエスト内 | rooms[] / time_designation_rows[] |
| 2 | NormalizedResult | サーバー内一時 | リクエスト内 | entries[] + timeDesignationRows[] |
| 3 | `LiveBoardStampEntry`（API応答 stampData） | HTTP応答 | 一時 | room_number/symbol/time_start/time_end/time/note/note_raw/needs_review/review_reason |
| 4 | **STAMP_DATA**（メモリ） | index.html クロージャ変数 | ページ内 | symbol/time/time_end/note/name(+経路ごとに追加キー) |
| 5 | stampScannedRooms（メモリ） | 一覧表示用 | ページ内 | STAMP_DATAと同型（同じ実体を代入） |
| 6 | `fireflow-stamp:<room>`（IndexedDB cache） | ローカル | 永続 | #4のJSON |
| 7 | `fireflow-stamp:<room>`（Supabase kv_store） | サーバー | 永続 | #4のJSON |
| 8 | outbox（IndexedDB） | 未送信キュー | 一時 | #4のJSON |
| 9 | scheduleLabels（メモリ） | 表示用 | 再計算 | text/color/timeDisplay |
| 10 | scheduleOverrides（メモリ＋`fireflow-schedule-override:<room>`） | 当日変更 | 永続 | time |
| 11 | Legacy `applyConfirmedFsdfToLb` の戻り値 stampData | 一時→#4へ全置換 | – | Legacy形式 |
| 12 | CSV取込の newStampData | 一時→#4へ全置換 | – | 5キーのみ |
| 13 | Supabase `stamp_data` テーブル | realtime購読対象として名前だけ存在 | – | 未使用 |

**同じ情報の保持箇所＝実質7（#3〜#10）。うち恒久保存が2重（IndexedDB / kv_store）。**

**現在、実LBの最終表示を決めているのは #4 STAMP_DATA（＋#10 scheduleOverrides の上書き）だけ。**
#3の`time_start`は#4では`time`へリネームされ、`note_raw`・`review_reason`以外の監査情報は保存時に落ちる。

---

## 4. 二重管理・多重管理箇所

1. **STAMP_DATA の書き込み口が12箇所**（`public/index.html`）
   - 4324 デモ用ハードコード初期値（102〜817）
   - 4578 `restoreStampDataFromStorage`（復元）
   - 4609 `resetInspectionDataForCurrentRoomSet`（全消去＋kv削除）
   - 4642 `clearDemoStampDataForPropertyChange`（メモリのみ消去）
   - 5895 捺印表一覧UIの「×」削除
   - 6048 `applyStampBulkResult`（**Legacy** PDF一括）
   - 6135 `applyStampSingleOcrResult`（**Legacy** 画像1枚）
   - 6201 手動レビュー保存（Legacy画面）
   - 6293 `handleOcrScheduleConfirmedFsdf`（**Legacy/FSDF**。`STAMP_DATA`を**丸ごと差し替え**）
   - 6449 `applyStandardizedStampDataToLb`（**新捺印表**）
   - 6631 テストブリッジ
   - 10633 CSV取込（**丸ごと差し替え**、永続化なし）
2. **エントリの形が経路ごとに違う**（同じキーに別スキーマが入る）
   - Legacy：`{symbol,time,time_end,time_mode,note,name,scheduleDate,scheduleDay}`
   - 新捺印表：`{symbol,time,time_end,note,name,a_checked,p_checked,cancel_checked,needs_review,review_reason}`
   - CSV：`{symbol,time,time_end,note,name}`
   - **どの経路で入ったかを示す `source` が存在しない**（判別不能）。
3. **恒久保存が2系統**：IndexedDB `cache`（`own:/shared:`前置）と Supabase `kv_store`。書き込みは両方、
   **復元は Supabase 側だけ**（§5-3）。
4. 表示用の再計算が2段（`scheduleLabels` と `effectiveScheduleLabel`）。後者は `scheduleOverrides` で
   確定済みの時刻を上書きする（＝後段での再解釈）。

---

## 5. 値を上書き / 削除 / 再生成する箇所

| 契機 | 関数 | STAMP_DATA | `fireflow-stamp:*` | FLOORS(MASTER) |
|---|---|---|---|---|
| 新捺印表 読み取り | `runStandardizedStampScan` | 全消去→65室で置換 | 上書き保存 | 触らない ✅ |
| Legacy 画像/PDF 読み取り | `applyStampSingleOcrResult` / `applyStampBulkResult` | 部屋単位で上書き | 上書き保存 | **`extendRoomRosterFromRoomNumbers`で部屋を追加** ❌ |
| Legacy FSDF確定 | `handleOcrScheduleConfirmedFsdf` | **オブジェクトごと差し替え** | 適用分のみ保存 | 追加しない(`newRoomPolicy:'skip'`) |
| CSV取込 | 10633 | **オブジェクトごと差し替え** | **保存しない**（再読込で消える） | 触らない |
| 実物件Excel読込 | `parseExcelAndRebuild` | **全消去のみ（復元しない）** ❌ | 残る（ゴースト化） | 再構築 |
| 新規物件作成 | `createNewProperty` | 空 | `resetInspectionDataForCurrentRoomSet`は**当時のSTAMP_DATAのキー分しか消さない** | 空 |
| 「前回の物件を続ける」 | `applyCurrentPropertyRecord` | 全消去→復元 | 読み出し | 復元 |
| 新規/デモ起動 | – | 復元しない ❌ | 残置 | – |
| ページ再読込（同上以外） | – | デモ初期値のまま | 残置 | – |
| 1秒ポーリング | `loadAll` | 触らない | – | – |
| 部屋カード再描画 | `renderFloors` | 触らない | – | – |

### 5-1. 「1101が一度表示され、その後また消えた」を説明できる構造（3つ実在）

1. **Excel再読込・物件情報更新で `clearDemoStampDataForPropertyChange()` が呼ばれるが、
   `restoreStampDataFromStorage()` が呼ばれない。** 永続データは残っているのに画面から消える。
   （`parseExcelAndRebuild` 内 ②リセット。復元呼び出しは `applyCurrentPropertyRecord` にしか無い）
2. **復元は「前回の物件を続ける」を選んだときだけ。** 「新規物件を作成」「デモを開く」、
   およびゲートを経ない再表示では復元されない。
3. **`storageList()` にローカルフォールバックが無い。**
   `public/index.html:4250-4258` — `window.storage` が未初期化、または Supabase 呼び出しが失敗した場合、
   例外を投げずに `{keys: []}` を返す。`restoreStampDataFromStorage()` はこれに全依存しているため、
   **オフライン・未ログイン・セッション切れ・通信失敗のとき、保存済みでも静かに0件復元**になる。
   書き込みは IndexedDB へ必ず入っているのに、読み出し経路がそこを見ていない。

### 5-2. 物件スコープが無い（混入リスク）

`public/supabase-integration.js:20`
```js
const PROPERTY_ID = 'b6e18eed-f2f3-4674-812d-322732908616'; // コスモ六甲ガーデンフォート
```
kv_store の全行がこの**ハードコードされた1つの property_id** に紐づく。`fireflow-stamp:<room>` に
物件識別子が無いため、別物件で同じ部屋番号があれば前の物件の捺印データが復元されうる。
（`restoreStampDataFromStorage` は現FLOORSに在る部屋だけへ復元するので部屋数は壊れないが、
値は混入しうる）

### 5-3. 保存と復元の非対称（要点）

| | 書き込み | 読み出し |
|---|---|---|
| IndexedDB `cache` | 必ず書く | **復元経路から一切読まない**（`storageGet`単発のフォールバックのみ） |
| Supabase `kv_store` | 書く（失敗時はoutbox） | `storageList`＋`storageGet`。失敗時は静かに空 |

---

## 6. Legacy / New OCR の関係

| 項目 | 実態 |
|---|---|
| 両方生きているか | **両方生きている** |
| 同じUIから到達するか | **到達する。** 表示上の入口は「資料を読み込む」1つだが、`routeUnifiedUpload` は「画像**1枚**」だけを新経路へ回し、**PDF・複数枚選択・HEIC等は `openDocBatchUploadDialog`→`processDocBatchDraft` へ渡り、画像は `/api/scan-time-request`（Legacy単票）、PDFは Legacy一括へ自動投入される**（index.html:10200付近）。新捺印表をPDF化・複数枚化した瞬間にLegacyへ入る |
| 同じ保存領域へ書くか | **書く。** 両者とも `STAMP_DATA` と `fireflow-stamp:<room>` |
| 片方が他方を上書きするか | **する。** Legacy FSDF確定とCSV取込は `STAMP_DATA` をオブジェクトごと差し替える |
| 再読込で経路が切り替わるか | 復元は形式を見ずにJSONをそのまま `STAMP_DATA` へ戻すため、**Legacy形式と新形式が混在した状態が復元される** |
| MASTERへの影響 | Legacyの2経路は `extendRoomRosterFromRoomNumbers()` で **FLOORS に部屋を追加する**（新経路は追加しない） |

分類：

| 対象 | 分類 | 理由 |
|---|---|---|
| `/api/scan-time-request`（点検希望時間連絡票OCR） | **KEEP** | 別様式（部屋ごと1枚）の正規機能。廃止対象ではない |
| Legacy結果を `STAMP_DATA`/`fireflow-stamp:*` へ直接書く3関数 | **MODIFY** | 書き込み先を新Storeへ集約し、`source`を必ず持たせる |
| `handleOcrScheduleConfirmedFsdf` の `STAMP_DATA` 丸ごと差し替え | **MODIFY** | 全置換をやめ、部屋単位のマージへ |
| CSV取込（10633）の全置換＋非永続 | **DEPRECATE** | 新Storeに寄せるまで入口を塞ぐ（永続化されず再読込で消えるため現状は事故源） |
| `openStampScan()` 系のLegacy手動画面（DOM非表示のまま残置） | **DEPRECATE** | UIから到達不能。テストのみが参照 |
| Supabase `stamp_data` テーブルの realtime 購読 | **DELETE_CANDIDATE** | テーブルは使われていない（kv_storeに保存しているため） |
| `__ffOcrConfirmTestBridge` | **KEEP** | 自動テスト用。本番からは呼ばれない |

---

## 7. FireFlow辞書の実際の位置

- 実装：`lib/ocr/standardizedStampSheet/misreadDictionary.ts` ＋
  `dictionaries/canonicalTermDictionary.v1.json`（朝一/午後一/ラスト/以降いつでも 等）、
  `dictionaries/ocrMisreadDictionary.v1.json`
- 呼ばれている場所：
  1. `timeDesignation.joinTimeDesignationRows()`（時間指定行の備考） ← 実運用で効いている位置
  2. `normalizeStandardizedStamp.normalizeStandardizedStampEntry()`（旧経路。現行の呼び出しは無い）
- 判定結果の扱い：`auto_correct` のときだけ `toLiveBoardStampData` が `note` を確定。
  それ以外は `note=''`＋`note_raw`保持＋`needs_review`。**この判断は1箇所のみで行われている（良い）。**
- 後段での再解釈：**無い。** LB側（`initScheduleLabels`/`renderFloors`）は `note` を表示するだけ。
- 保存時：`applyStandardizedStampDataToLb` が `note` を保存する一方、**`note_raw`・`needs_review`の理由は
  保存対象に含まれるが、`note_raw`は保存されない**（保存JSONは symbol/time/time_end/note/name/
  a_checked/p_checked/cancel_checked/needs_review/review_reason）。→ **再読込後に備考原文が失われる**（記録：Bug-P0-1）
- 実測（2026-08-14の実LB1回分）：同じ帳票の同じ欄が、ある回は「朝一」→`auto_correct`、
  別の回は「都合ー」→辞書不一致。**辞書自体は正しく機能しており、揺れているのはOCR読字**。

---

## 8. MASTERとの関係

- MASTERはExcel由来（`parseExcelAndRebuild` → FLOORS/SENSOR_MASTER）。実物件66室。
- 新捺印表経路は **FLOORS を一切書き換えない**（`applyStandardizedStampDataToLb` に `FLOORS =` は無く、
  未知部屋は `unmatchedRooms` へ）。OCR65室でも **LB 66室・1102は部屋あり/stampなし** を実データで確認済み。
- **リスクはLegacy側**：`extendRoomRosterFromRoomNumbers()` が FLOORS に部屋を追加する。
  新捺印表をPDF/複数枚で読み込ませるとこの経路に入るため、**MASTERが汚染されうる**（記録：Bug-P0-2）。

---

## 9. 今回の不安定動作が起きる構造的原因（結論）

サーバー側（OCR→辞書→正規化→LB変換）は**単線で、実データでも正しい値を出している**。
不安定さは全て**ブラウザ側の「保存・復元・反映」の接続層**に集中している。

| # | 構造的原因 | 症状 |
|---|---|---|
| 1 | 保存先が2系統、復元は片方（Supabase）だけ。`storageList`は失敗を空で握り潰す | 読み取り直後は出るのに、再読込で全部消える回がある |
| 2 | 復元の呼び出しが「前回の物件を続ける」1経路のみ | 起動の選び方によって出たり出なかったりする |
| 3 | Excel再読込は消去だけして復元しない | 一度出た1101が、その後の物件読み直しで消える |
| 4 | STAMP_DATAの書き込み口が12・形式が3種・`source`なし | どの値が今画面に出ているのか特定できない |
| 5 | Legacy経路が同じ入口・同じ保存キーへ別形式で書く／FLOORSを増やす | 経路が変わると結果も変わる。MASTER汚染の恐れ |
| 6 | 保存JSONが正本の部分集合（note_raw・cells・confidence等を落とす） | 復元後に監査情報が失われ、原因追跡が毎回OCRからやり直しになる |
| 7 | kv_storeキーに物件スコープが無い（PROPERTY_IDハードコード） | 別物件の同番部屋の値が混入しうる |
| 8 | テストが Level1〜4 相当止まりで、実ブラウザ1往復（Level5）を持たない | unit/release/build PASS でも実LBと一致しない |

---

## 10. KEEP / MODIFY / DEPRECATE / DELETE_CANDIDATE

| 資産 | 分類 | 備考 |
|---|---|---|
| `lib/ai/**`（OCR呼び出し・プロバイダ抽象・プロンプト） | **KEEP** | 実データで65/65の記号一致。変更不要 |
| `lib/ocr/standardizedStampSheet/{parseRawScanResult,symbolConvergence,gridTimeParser,timeDesignation,normalizeStandardizedStamp}` | **KEEP** | 誤確定0優先の判断が1箇所に集約済み |
| `misreadDictionary.ts` ＋ 辞書JSON | **KEEP** | 正式経路内で機能している |
| `toLiveBoardStampData.ts` | **MODIFY** | 出力を新Canonicalへ（`source`/`updated_at`/`property_key`/`confidence`追加） |
| `lib/handlers/scanStandardizedStampSheet.ts` | **MODIFY** | 返す形をCanonicalに合わせる |
| `applyStandardizedStampDataToLb`（index.html） | **MODIFY** | 直接STAMP_DATAを触らず、新Storeへ`put`するだけにする |
| `restoreStampDataFromStorage`（index.html） | **MODIFY** | 新Storeの`loadAll`へ。ローカル→リモートの二段フォールバック |
| `storageList`（index.html） | **MODIFY** | IndexedDB `cache` からのprefix一覧を必ずマージ |
| `initScheduleLabels` / `renderFloors` / 部屋カードCSS | **KEEP** | 表示側は正しく動いている（実データで確認済み） |
| `clearDemoStampDataForPropertyChange` | **MODIFY** | 「消去→復元」を必ず対で呼ぶ責務へ |
| Legacy `applyStampBulkResult` / `applyStampSingleOcrResult` / 手動レビュー保存 | **MODIFY** | 新Store経由・`source:'legacy_*'`付与・FLOORS追加をやめる |
| `handleOcrScheduleConfirmedFsdf` の全置換 | **MODIFY** | 部屋単位マージへ |
| CSV取込（10633） | **DEPRECATE** | 非永続の全置換。新Storeへ寄せるまで入口を閉じる |
| `openStampScan()`系Legacy手動UI | **DEPRECATE** | UIから到達不能 |
| Supabase `stamp_data` テーブル購読 | **DELETE_CANDIDATE** | 未使用 |
| `PROPERTY_ID` ハードコード（supabase-integration.js:20） | **MODIFY**（Phase 1の前提） | 物件スコープの根本 |
| Ground Truth（`ground_truth_shinnain_v1_20260811.json`、`public/test/fixtures/prop13/*`） | **KEEP** | 回帰テストの基準 |
| 既存 unit/release テスト | **KEEP＋追加** | §12のLevel構造へ再配置 |

---

## 11. 新Canonical Data 仕様案

`FireFlowStampRecord`（部屋1件＝1レコード。これ以外の形式で持たない）

```jsonc
{
  "schema_version": 1,
  "property_key": "cosmo-joto-noe",      // 物件スコープ。MASTER側の識別子を使う
  "room": "801",                          // MASTERに存在する部屋番号のみ
  "symbol": "A",                          // '' | 'A' | 'P' | 'キャンセル'（確定時のみ）
  "time_start": "09:30",                  // '' | 'HH:MM'
  "time_end": "",
  "time_mode": "exact",                   // exact | range | end_only | none（Legacy互換）
  "note": "朝一",                          // 辞書で確定した業務語のみ
  "note_raw": "朝一",                      // 読み取り原文（必ず保持）
  "dictionary_match": {                   // 辞書判定の結果をそのまま保存
    "normalized_code": "EARLY_MORNING",
    "state": "auto_correct",              // auto_correct | candidate | needs_review
    "matched_via": "exact_canonical"
  },
  "raw_checkboxes": { "a": true, "p": false, "cancel": false },
  "needs_review": false,
  "review_reason": [],                    // 例: ["SYMBOL:MULTIPLE_SYMBOL_CHECKED"]
  "confidence": { "symbol": "auto_confirmed", "time": "auto_confirmed" },
  "source": "standardized_stamp_sheet",   // standardized_stamp_sheet | legacy_time_request | csv | manual
  "source_ref": { "row_index": 5, "cells": { "start": ["","9","3","0"] } }, // 監査用（表示に使わない）
  "updated_at": "2026-08-15T02:11:00.000Z"
}
```

原則：
- **確定はサーバー側で完結**（OCR→辞書→業務ルール→このレコード）。
- ブラウザ側は **put / get / render しかしない**。値の再解釈・再判定を一切しない。
- 保存は**このレコードをそのまま**。部分集合に落とさない（現状の情報欠落を止める）。
- 表示専用の派生（`scheduleLabels`）は常にこのレコードから再計算し、**保存しない**。
- `scheduleOverrides`（当日変更）は別レコードのまま。表示時に重ねるが、Canonicalは書き換えない。

---

## 12. 新パイプライン図

```
実画像
  ▼
[サーバー] OCR raw
  ▼ FireFlow辞書（1回だけ）
  ▼ 業務ルール（記号収束・時刻確定・行結合）
  ▼ normalize
  ▼ ★FireFlowStampRecord[]（唯一の正本。property_key + source + updated_at 付き）
  ▼ HTTP応答
[ブラウザ] StampStore.putMany(records)      ← 新設。STAMP_DATAへ直接書く箇所を全廃
  ├─ メモリ（Map）
  ├─ IndexedDB（cache: 'stamp:<property_key>:<room>'）    …必ず成功
  └─ Supabase kv_store（同キー、失敗時はoutbox再送）
  ▼
StampStore.subscribe → initScheduleLabels() → renderFloors()
  ▼
部屋カード（記号・時刻・備考・要確認）

[再読込]
StampStore.loadAll(property_key)
  ├─ 1st: IndexedDB（必ず読める。オフラインでも復元できる）
  ├─ 2nd: Supabase（新しいものだけ updated_at で採用）
  └─ MASTER(FLOORS)に無い部屋は読み込まない（66室を壊さない）
```

要件：
- LB描画側でOCR判断をしない（現状も守られている。維持）。
- 保存側で再解釈しない（Canonicalをそのまま保存）。
- 再読込で再OCRしない。
- 同じデータを複数形式で独立管理しない（STAMP_DATA/stampScannedRooms/localの3重を1つに）。

---

## 13. 保存 / 復元方式

- キー：`stamp:<property_key>:<room>`（**物件スコープを含める**）。旧`fireflow-stamp:<room>`は
  読み取り専用の移行元として一度だけ取り込む（`property_key`が判明している場合のみ）。
- 書き込み順：メモリ → IndexedDB（await）→ リモート（fire-and-forget＋outbox）。
- 復元順：IndexedDB → リモート差分マージ（`updated_at`が新しい方を採用）。
  **リモートが応答しなくても復元できる**ことを必須要件とする。
- 消去：物件切替・新規作成時は `property_key` 単位で消す（現行の「メモリのキー分だけ消す」をやめる）。
- 復元の呼び出し：起動4経路（前回継続／新規／デモ／Excel読込後）すべてで、
  `clear(property_key)` と `loadAll(property_key)` を**必ず対で**通す。

---

## 14. テスト戦略

| Level | 対象 | 実行方法 | 現状 |
|---|---|---|---|
| 1 | parser / dictionary / 記号収束 | `test:unit`（既存） | 有 |
| 2 | OCR raw → Canonical | 保存済み実OCR JSONを入力に固定（`scratchpad/raw_scan.json`相当をfixture化） | **無 → 追加** |
| 3 | Canonical → 保存 → 復元 | IndexedDB/リモートのスタブで往復。リモート失敗時の復元も必須ケース | **無 → 追加** |
| 4 | Canonical → LB描画 | index.htmlの実関数をvmで実行し部屋カードHTMLを検証（既存の手法を流用） | 一部有 |
| 5 | 実画像 → 実API → Canonical → 保存 → 再読込 → 実LB | ヘッドレスブラウザで実ページを操作。**Level5未通過ならGOを出さない** | **無 → 追加（Phase 1の必須成果物）** |

- 回帰ケースは物件別ディレクトリで管理し、1101/801はその1件として扱う（特定物件専用の分岐は禁止）。
- Level 2 は「同じ帳票でもOCR出力が揺れる」前提で、**複数の実測rawを別ケースとして保持**する
  （例：801の備考が「朝一」の回と「都合ー」の回、1101の時刻マスが `['','9','3','0']` の回と `['9','','3','0']` の回）。

---

## 15. 移行手順（Phase 1以降）

1. `FireFlowStampRecord` 型と変換（`toLiveBoardStampData`→`toStampRecords`）を追加。既存出力も併走で返す。
2. ブラウザに `StampStore`（メモリ＋IndexedDB＋リモート、`property_key`スコープ）を新設。
3. `applyStandardizedStampDataToLb` を `StampStore.putMany` の薄いラッパへ。
4. 起動4経路すべてで `clear`＋`loadAll` を対で呼ぶよう結線。`storageList` にローカル一覧を実装。
5. `initScheduleLabels` の入力を `StampStore.get(room)` に切替（描画ロジックは変更しない）。
6. Legacy 3経路を `StampStore.putMany`（`source:'legacy_*'`）へ寄せ、`extendRoomRosterFromRoomNumbers` の
   呼び出しを外す（MASTER保護）。
7. 旧 `fireflow-stamp:*` の一度きり移行を実装。
8. Level 2〜5 のテストを追加し、Level 5 を GO 条件にする。
9. CSV取込の入口を閉じる（DEPRECATE）。

---

## 16. リスク

| リスク | 対策 |
|---|---|
| `PROPERTY_ID` ハードコードのまま物件スコープを導入すると、リモート側は分離できない | Phase 1では**キー名に`property_key`を含める**ことで論理分離。DB側の物件分離は別タスク（要ユーザー判断） |
| 既存の永続データ（`fireflow-stamp:*`）が消える | 移行は「読み取って新キーへ複製」。旧キーは削除しない |
| Legacy利用者の既存フローが壊れる | Legacy経路は入口・UIを変えず、書き込み先だけ差し替える |
| index.html が1.6MBの単一ファイルで衝突しやすい | StampStoreは別ファイル（`public/stamp_store/`）に置き、index.htmlからは薄く呼ぶ |
| ヘッドレスE2Eが認証（Supabase）を要する | Level5は「ログイン済みプロファイル」または開発用トークンで実行。設計時にユーザー確認 |

---

## 17. Phase 1 実装計画

| # | 作業 | 規模感 |
|---|---|---|
| 1 | `FireFlowStampRecord` 型＋`toStampRecords`＋handler出力追加 | 新規1・変更2ファイル |
| 2 | `public/stamp_store/stamp_store.js`（put/get/loadAll/clear/移行） | 新規1（約250行） |
| 3 | index.html：apply/restore/clear/storageList/initScheduleLabels の結線差し替え | 変更5〜6箇所 |
| 4 | Legacy 3経路の書き込み先差し替え＋FLOORS追加停止 | 変更4箇所 |
| 5 | Level2/3/4 テスト追加 | 新規3ファイル |
| 6 | Level5 実LB E2E | 新規1（要ユーザー確認事項あり） |

**目安：新規5ファイル・変更6ファイル・index.htmlの変更は10箇所程度。OCR/辞書/normalizeは無変更。**

---

## 18. 想定変更ファイル一覧

**変更**
- `lib/ocr/standardizedStampSheet/toLiveBoardStampData.ts`（→ Canonical出力）
- `lib/handlers/scanStandardizedStampSheet.ts`（応答形）
- `public/index.html`（apply / restore / clear / storageList / initScheduleLabels / Legacy 3経路）
- `public/supabase-integration.js`（`PROPERTY_ID` の扱い。※方針はユーザー確認後）
- `test/unit/lb/standardizedStampLbBridge.test.ts`（Level4へ再編）

**新規**
- `lib/ocr/standardizedStampSheet/stampRecord.ts`（型＋変換）
- `public/stamp_store/stamp_store.js`
- `test/unit/ocr/standardizedStampSheet/stampRecord.test.ts`（Level2）
- `test/unit/lb/stampStore.test.ts`（Level3）
- `test/e2e/standardizedStampSheet.e2e.*`（Level5）

**無変更（KEEP）**
- `lib/ai/**`、`parseRawScanResult.ts`、`symbolConvergence.ts`、`gridTimeParser.ts`、
  `timeDesignation.ts`、`normalizeStandardizedStamp.ts`、`misreadDictionary.ts`＋辞書JSON、
  Ground Truth、部屋カードUI/CSS

---

## 19. 調査中に発見したが今回修正しなかったバグ（記録のみ）

| ID | 内容 | 影響 |
|---|---|---|
| Bug-P0-1 | 保存JSONに `note_raw` が含まれず、再読込で備考原文が失われる | 要確認理由の追跡が不能 |
| Bug-P0-2 | Legacy 2経路が `extendRoomRosterFromRoomNumbers()` でFLOORSへ部屋を追加 | MASTER 66室が壊れうる |
| Bug-P0-3 | `storageList` にローカルフォールバックが無く、失敗が空扱い | 保存済みでも復元0件 |
| Bug-P0-4 | Excel再読込がSTAMP_DATAを消去するのみで復元しない | 表示済みの値が消える |
| Bug-P0-5 | CSV取込が `STAMP_DATA` を全置換し永続化しない | 再読込で消える |
| Bug-P0-6 | `PROPERTY_ID` ハードコードで物件スコープが無い | 別物件のデータ混入 |
| Bug-P0-7 | 時間指定欄の断片行（時刻・備考なし）が「未反映の時間指定」として警告される | 毎回の誤警告 |

---

## 20. 判断

### **結論：B（接続部分を切り離して再実装する）**

ただし「作り直し＝全部捨てる」ではない。**再実装するのは、ブラウザ側の保存・復元・反映の接続層だけ**で、
OCR・FireFlow辞書・正規化・MASTER・部屋カードUIはそのまま残す。

**根拠（実コード）**

1. サーバー側は既に一本線で、実データで正しい値を出している
   （実画像1枚 → 65室・1101=A/09:30・801=A/09:30＋備考、MASTER66室維持を実測済み）。
   ここを作り直す理由が無い＝Aの「整理」で足りる部分。
2. 一方でブラウザ側は、`STAMP_DATA` の書き込み口が **12箇所**・形式が **3種**・`source` 無し。
   個別に整えるには12箇所すべての不変条件を同時に守る必要があり、
   これまでのパッチが「ある回は直り、別の回で壊れる」形で失敗してきた原因そのもの。
3. 復元は `storageList` の1本足で、失敗を空で握り潰す（`public/index.html:4250-4258`）。
   これは「整理」ではなく**保存/復元の方式そのものの変更**が必要（ローカル優先＋リモート差分）。
4. 復元の呼び出しが起動4経路のうち1経路にしか無く、Excel再読込は消去のみ。
   結線の追加ではなく、**「消去と復元を必ず対で通す」という契約を持つ層**が要る。
5. 物件スコープがキーに無い（`PROPERTY_ID`ハードコード）。既存キー設計のままでは
   物件をまたいだ混入を構造的に防げない。

つまり**Aで足りる部分（サーバー側）とBが必要な部分（ブラウザ側の永続化・反映）が明確に分かれている**。
接続層だけを1つの `StampStore` として切り出す方が、変更箇所も検証範囲も小さく、
Level 5（実LB往復）を自動テストで固定できるため、結果的に安全かつ速い。
