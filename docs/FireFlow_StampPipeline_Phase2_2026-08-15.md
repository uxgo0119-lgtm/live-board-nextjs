# FireFlow 新捺印表パイプライン Phase 2：OCR接続層のシンプル化・重複経路削減

作成日：2026-08-15
対象：`~/FireFlow/live-board-nextjs`
方針：機能追加ではなく**引き算**。誤確定は防ぐ／しかし正しく読めた情報は途中で捨てない。
commit / push / deploy：なし。

---

## 1. 唯一の正本と、その一本道

```
実画像
  ▼ [サーバー] OCR raw
  ▼ FireFlow辞書（1回だけ：timeDesignation の備考）
  ▼ 業務ルール（記号収束・時刻マス確定・行結合）
  ▼ normalize（normalizeStandardizedStampScan：入口は1つ）
  ▼ ★Canonical Data（LiveBoardStampEntry。項目単位の確定を含む）
  ▼ HTTP応答
[ブラウザ] StampStore.putMany()          ← 予定情報の書き込み口はここだけ
  ├ メモリ（正本）
  ├ IndexedDB（'stamp:<物件>:<部屋>'）    …必ず成功
  └ リモート（失敗時は送信キュー）
  ▼ syncStampDataFromStore()             ← STAMP_DATA は派生ビューへ降格
  ▼ initScheduleLabels → renderFloors    ← 再解析・再判定なし
```

再読込：`StampStore.loadAll()` → ローカル一覧を必ず含めて復元 → 同じ描画経路。

---

## 2. 項目単位の確定（Phase 2 の中心）

要確認は部屋単位の1フラグではなく、項目ごとに持つ。

| 項目 | 確定条件 | 未確定のとき |
|---|---|---|
| symbol | 記号収束が auto_confirmed | 値を入れない。`symbol_review` |
| time_start / time_end | マス単位で確定（0補完しない） | 値を入れない。`time_review` |
| note | FireFlow辞書が auto_correct | `note` は空、`note_raw` は必ず保持。`note_review` |

- 分類は `lib/ocr/standardizedStampSheet/fieldReview.ts` の1箇所のみ。
- `symbol_review` / `time_review` / `note_review` / `other_review` は、
  Canonical → 保存 → 復元 → 描画ビューまで同じ意味で流れる。
- 部屋カードは従来どおり「要確認」バッジ1種。説明文（title）にどの項目かを出す。

### 撤廃した全体ゲート

`timeDesignation.joinTimeDesignationRows()` の
`confirmed = (理由が1つでも無いこと)` を、
**結合可否（部屋を特定できるか）** と **項目ごとの確定** に分離した。

- 備考が辞書に無い語 → 時刻は確定して届く（Phase 1 で対応済み、構造として固定）
- 開始が読めて終了が読めない → **開始は届く**（今回追加）
- 逆も同じ

`unassigned`（＝利用者へ「部屋を特定できない時間指定 N件」と表示する数）は、
**部屋を特定できなかった行だけ**を数える意味に統一した。

---

## 3. 削除・停止した重複経路

| 対象 | 処置 | 理由 |
|---|---|---|
| `normalizeStandardizedStampEntry` / `Entries` / `ScanResult` | **削除** | 本体グリッドに時刻がある前提の旧経路。未使用かつ**FireFlow辞書を呼ぶ2つ目の場所**だった |
| `parseGridTime`（文字列版） | **削除** | 空マスの0補完を検知できず 1101/801 の誤確定を招いた経路。未使用 |
| `verify_real_sample.ts`（リポジトリ直下） | **削除** | 旧経路を使う一時検証スクリプト。特定物件の部屋番号を直書き |
| Supabase `stamp_data` テーブルの realtime 購読 | **停止** | 誰も書いていないテーブル。予定情報の出所が2つに見える |
| `STAMP_SCAN_KEY_PREFIX`（`fireflow-stamp:`） | **削除** | index.html から未参照。旧キーは StampStore が復元時に一度だけ取り込む |
| `STAMP_DATA = {}`（reset / clear の2箇所） | **停止** | 派生ビューへの直接代入をやめ、正本を消してから作り直す |
| `matchAgainstDictionaries('')`（初期値作り） | **置換** | `blankMisreadMatch()` へ。辞書の適用箇所を1つに見せるため |

## 4. 残した経路（KEEP）

- `lib/ai/**`（OCR呼び出し）、`parseRawScanResult` / `symbolConvergence` /
  `gridTimeParser`（マス版）/ `timeDesignation` / `misreadDictionary` ＋辞書JSON
- Excel由来MASTER、Ground Truth、部屋カードUI/CSS、既存テスト資産
- `/api/scan-time-request`（点検希望時間連絡票＝別様式）
- Legacy / CSV / 手入力：**入口は変えず、出力先だけ StampStore に統一**
- `scheduleOverrides`（当日の時刻変更）：OCR結果の再解釈ではなく利用者が入れた別データのため、
  表示時に重ねる現行のままとする。Canonical は書き換えない。

## 5. MASTERと予定情報の分離

- OCRは **FLOORS を一切変更しない**。MASTERに無い部屋は `NOT_IN_MASTER` で拒否。
- Legacy 2経路の `extendRoomRosterFromRoomNumbers()` 呼び出しは停止済み（Phase 1）。
  ソース上のテストで固定している。
- 実測：MASTER 66室／OCR 65室／1102は部屋あり・予定情報なし。

## 6. テスト構成（5段階）

| Level | 内容 | ファイル |
|---|---|---|
| 1 | parser / 辞書 / 記号収束 / **項目分類** | `gridTimeParser` `misreadDictionary` `symbolConvergence` `fieldReview` |
| 2 | **実OCR raw → Canonical** | `realScanToCanonical`（fixture: `test/fixtures/standardizedStampSheet/real_scan_prop13_20260814.json`） |
| 3 | Canonical → 保存 → 復元 | `lb/stampStore`（リモート断・物件スコープ・項目単位の往復） |
| 3+ | **実LBの保存アダプタ結線そのもの** | `lb/stampStorageAdapterRoundTrip`（2026-08-15追加。下記） |
| 4 | Canonical → 描画 | `lb/standardizedStampLbBridge` |
| 5 | 実画像 → 実LB | **ユーザー操作が必要（未実施）** → `docs/FireFlow_StampPipeline_Phase2_実LB確認手順_2026-08-15.md` |
| — | パイプラインの形（辞書1箇所・入口1つ・正本1つ） | `pipelineShape`, `standardizedStampLbBridge` §6 |

## 7. 実測（実OCR raw 1回分・fixture化済み）

| 部屋 | 記号 | 開始 | 終了 | 備考 | 判定 |
|---|---|---|---|---|---|
| 1101 | A | 09:30 | – | – | 確定 |
| 801 | A | 09:30 | – | 朝一 | 確定 |
| 802 | – | – | – | – | **記号のみ要確認**（A+P） |
| 1003 / 405 | P | – | – | – | 確定 |
| 705 | P | 13:00 | 14:00 | – | 確定 |
| 603 | A | 10:00 | – | – | 確定 |
| 1001 | A | 10:00 | 11:30 | – | 確定 |
| 503 | A | 11:00 | 11:15 | – | 確定 |
| 1305 | P | 14:00 | – | – | 確定 |
| 1102 | — | — | — | — | MASTERに部屋あり・予定情報なし |

確定 65室／要確認 3室（802・1005・805＝いずれも複数チェック）／
部屋を特定できない時間指定 1行（部屋番号マスに判読不能文字）。false positive の増加なし。

## 8. 今回修正しなかった記録

- `PROPERTY_ID` のハードコード（`supabase-integration.js:20`）。キー名の物件スコープで論理分離済み。
  DB側の物件分離は別タスク（要ユーザー判断）。
- `createNewProperty()` が旧物件の保存済みデータを消す挙動は Phase 1 以前からの仕様のため触っていない。
  物件スコープが入った今は必須ではないので、必要なら別タスクで見直す。

## 9. Phase 2 最終検証で埋めた穴（2026-08-15）

### (a) 保存アダプタ結線のテスト（`test/unit/lb/stampStorageAdapterRoundTrip.test.ts`）

Level 3 / Level 4 のテストは「保存→再読込→復元」を通していたが、保存先アダプタだけは
テスト用の単純なキー辞書に置き換えていた。実ブラウザで実際に通るのは

```
storageSet(key, value, true)  → lcPut('cache', { key: lcCacheKey(key, true), ... })
listKeysLocalFirst(prefix)    → lcGetAll('cache') のキーから 'shared:' を外して前方一致
storageGet(key, true)         → リモート優先／失敗時に lcGet('cache', 'shared:' + key)
```

という鎖であり、ここでキー名が1文字ずれるだけで「読み取り直後は出るのに再読込で消える」
（Phase 0で確定した症状）がそのまま再発する。IndexedDBの入出力だけをメモリ実装へ差し替え、
`lcCacheKey` / `storageSet` / `storageGet` / `listKeysLocalFirst` と
`createStampStore({adapters:…})` の結線は **index.html の実ソースをそのまま実行**する。

検証した通信状態（すべて再読込後に4室の状態が維持されること）：

1. `window.storage` 未初期化（起動直後・オフライン）
2. **保存はリモートへ届かず送信キューに残ったまま、再読込時はリモートが生きている**
   ← 最も危険。リモート優先で確定すると「行が無い＝予定情報なし」と解釈してしまう
3. リモート正常
4. リモートが「行が無い」を返しても、ローカルの正本が `null` で上書きされない（2回目の再読込でも復元できる）
5. 物件スコープが違えば同じ部屋番号でも復元しない

負のコントロールも実施：`lcCacheKey` のプレフィックスを変える／`listKeysLocalFirst` の
ローカル一覧を潰す、の2通りで **このテストが FAIL することを確認**した（index.html は元に戻してある）。

### (b) `window.storage.get` の挙動確認（推測ではなくソースで確定）

`public/supabase-integration.js` の `get()` は**行が無いとき例外を投げる**（`key not found`）。
そのため `storageGet` の `catch` が必ず走り、ローカルキャッシュへフォールバックできる。
「リモートが空を返して、ローカルの正本を静かに消す」経路は存在しない。

### (c) dev server のポート（実LB確認時の落とし穴）

無人実行時、ポート3000には**Phase 2の新エンドポイントを持たない古いdev server**が残っており、
`POST /api/v1/standardized-stamp-sheet/scan` が **404** を返した。
新しく起動した dev server（3001）では **401（＝認証要求＝正しく結線されている）**。
実LB確認の前に dev server を起動し直し、**表示されたURLを開く**こと。

## 10. 実LB最終確認で残った2件と、その修正（2026-08-15 無人実行）

実Live Board確認（実画像→実API）で確定した事実は次の2つ。802など他は期待どおり。

| 部屋 | 紙面（Ground Truth） | 実LBの表示 |
|---|---|---|
| 1101 | A / 9:30 | **要確認**。09:30が欠落 |
| 801 | A / 9:30 / 朝一 | A / 9:30 は出た。**備考「朝一」だけ欠落** |

### (a) 1101：時刻が最初に変わる場所 = `parseGridTimeCells()`

1101は**要確認バッジが付いていた**＝時間指定行はその行自身の部屋番号マスから1101へ結合できている
（結合できていなければ「部屋を特定できない時間指定」に回り、1101には理由が付かない）。
つまり値が最初に変わるのは、結合の前の**開始時刻マスの解釈**である。

その時点で「紙面は9:30なのに確定できない」形として残っていたのは、
**モデルが印字された区切り記号 `:` を配列の要素として返す**ケースだけだった（2026-08-13に実測済みの挙動）。

- 「時」が2桁： `['1','0',':','0','0']` → 5要素。`:` を除けば4マス揃うので**従来から確定できていた**
- 「時」が1桁： `['9',':','3','0']` → 4要素。`:` を除くと3マスになり、**桁数不足として確定できなかった**

2026-08-13にこの形を確定させない判断をした時点では、1桁の「時」を確定する規則そのものが無かった
（規則は2026-08-14に追加）。`:` は「時」欄と「分」欄の間の**印字された境界**なので、前後で分ければ
「時が1マス・分が2マス」と位置として確定する。これは `['9','','3','0']` を09:30として確定するのと
同じ構造の解釈であり、推測ではない。

**修正**：`parseGridTimeCells()` に「区切り記号がちょうど1つ + 前が1〜2マス + 後ろが2マスとも数字」
のときだけ確定する経路を追加（`lib/ocr/standardizedStampSheet/gridTimeParser.ts`）。
対象は「`:` を除くと4マス未満」＝**これまで必ず要確認へ倒れていた形だけ**で、既に確定していた形の
挙動は1つも変えていない。分側の空欄・判読不能・時側が全て空欄は従来どおり確定しない。

**次回の原因特定用**：確定できなかった時刻の要確認理由へ、マスの見え方を添えるようにした
（例 `TIME_START:MISSING_CELL(??:30)`）。実LBでは要確認バッジの説明にそのまま出て保存もされるため、
同じ症状が再発しても**再スキャンせずに**モデルが何を返したかを特定できる。

### (b) 801：備考が最初に消える場所 = 部屋カードの描画（`detailFor()`）

801は**時刻09:30が届いている**＝行は801へ結合され、備考の原文も同じ行から
`note_raw` として正本に書かれている。つまり `note` が空になったのは、
**OCRが返した備考の文字列がFireFlow辞書で `auto_correct` にならなかった**ためで、
これは設計どおり（確定していない業務語を確定扱いしない）。

問題はその先で、**部屋カードには `note` を出す描画パスしか無かった**こと。
結果として、原文が正本に保存されているのに画面からは完全に消え、利用者からは
「備考が何も書かれていない部屋」と区別が付かなくなっていた（原本を確認する手掛かりまで失われる）。

**修正**：`public/index.html` の `detailFor()` で、`note` が空でも `note_raw` があれば
**読み取った原文をそのまま**表示する。辞書の正規語へ寄せることも、具体的な時刻へ変換することもしない
ため誤確定は増えない。確定していないことは、その部屋に必ず付く既存の「要確認」バッジ
（説明に「備考」と出る）で示す。新しいバッジ・新しいCSSは追加していない。

### (c) 固定したテスト

- `gridTimeParser`：区切り記号込みの確定/非確定を両方向で固定（`['9',':','3','0']`＝09:30、
  分欠損・判読不能・区切り2個・分3マスは確定しない）
- `timeDesignation`：1101が区切り記号込みでも09:30のまま部屋へ届くこと／要確認理由にマスの見え方が入ること
- `standardizedStampLbBridge`：確定できなかった備考の原文が部屋カードに出ること、**再読込後も残る**こと

## 11. 実LB再確認で判明した3件目：801が「Aだけ」になる経路（2026-08-15 無人実行）

実LBでの報告は「1101はA/9:30で正常。**801はAだけ**で、9:30も朝一も出ない」だった。
10.(b) の修正は「備考だけが消える」症状の修正であり、**時刻ごと消える**この症状とは別経路。

### (a) 追跡結果：fixtureでは全経路が正常

実OCR raw fixture（`test/fixtures/standardizedStampSheet/real_scan_prop13_20260814.json`）を
Canonical生成 → StampStore.put → IndexedDB保存値 → loadAll復元 → `syncStampDataFromStore` →
render直前 → `detailFor()` → 部屋カードHTML まで**同一データで通した**ところ、801は
全段で `A / 09:30 / 朝一` を保持していた（`test/trace/stamp801Trace.ts`）。
つまり保存・復元・描画のどこにも消失点は無い。

### (b) 消失点 = Canonical生成（`toLiveBoardStampData()`）で、行の中身を件数へ潰していた

801の時刻・備考は捺印マスではなく**時間指定行**に書かれている。時間指定行は
その行自身の部屋番号マスからしか部屋へ結合しない（推測で隣の部屋へ割り当てない）。
部屋番号マスが1マスでも確定できない行は `unassignedTimeDesignationRows` へ回るが、
`toLiveBoardStampData()` は**そこで行を `unassignedTimeDesignationRowCount`（数値）へ潰していた**。

結果、同じ行で確実に読めていた `09:30` と `朝一` は**Canonical生成の時点で消え**、
保存にも描画にも残らない。801側には痕跡すら付かない（時刻が「記入なし」と同じ状態になり
要確認にもならない）ため、利用者からは「801には時間指定が無い」ようにしか見えず、
原本を照合する手掛かりも失われていた。実運用で起こりうる部屋番号マスの崩れ
（判読不能 `_80?` / 途中欠け `_8_1` / 0埋め `0801` / 全欠け）すべてで再現する
（`test/trace/stamp801Repro.ts`）。実LBの症状「Aだけ出る」と完全に一致する。

### (c) 修正：読めた内容を捨てずに持ち出す（1箇所）

`toLiveBoardStampData()` の返り値へ `unassignedTimeDesignations`（型 `UnassignedTimeDesignation[]`）を追加し、
その行で**確定できた時刻・読み取った備考の原文・部屋番号マスの見え方**をそのまま運ぶ。
部屋の推定・時刻の補完・備考の正規化は一切しない。**どの部屋にも書き込まない**ので誤確定は増えない。
件数（`unassignedTimeDesignationRowCount`）は従来どおり残す。

同じ内容をAPI応答（`lib/handlers/scanStandardizedStampSheet.ts`）まで通し、
`public/index.html` では既存の読み取りパネル内に
「この時間指定は部屋番号を読み取れなかったため、どの部屋にも反映していません」として
`09:30 備考「朝一」（部屋番号のマス「_80?」）` の形で表示する
（既存 `escapeHtml()` を通す。新しいバッジ・新しいCSSは追加していない）。

特定部屋番号のハードコードはしていない。今後どの物件・どの行で起きても同じ扱いになる。

### (d) 固定したテスト

- `standardizedStampUploadRoute`：未割当行の読み取り内容がAPI応答から実導線を通って
  利用者に見える形まで届くこと（件数だけにならないこと）
- `toLiveBoardStampData` / `realScanToCanonical`：fixtureの801が `A / 09:30 / 朝一` のままであること（1101も同時に固定）

## 12. 判定

unit（35ファイル）/ release / typecheck / build いずれもPASS。
**1101・801の修正後も、この判定は変わっていない**（2026-08-15 無人実行で再実行済み）。
修正後の実Live Board は未確認のため **UI_UNVERIFIED**。
`docs/FireFlow_StampPipeline_Phase2_実LB確認手順_2026-08-15.md` の①〜④が通れば **LOCAL_GO**。

### 12.1 再検証（2026-08-15 無人実行・タスク未指定回）

`docs/current_task.md` が未記入だったため、新しい実装は行わず**現状維持の確認のみ**を実施した。

| 項目 | 結果 |
|---|---|
| `npm run test:unit`（35ファイル） | PASS |
| `npm run test:release` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS（`/api/v1/standardized-stamp-sheet/scan` がルート一覧に出ることを確認） |

稼働中のdev server（ポート3000）への実確認：

- `GET /` → **200**（Live Board本体が配信される）
- `POST /api/v1/standardized-stamp-sheet/scan` → **401**（＝認証要求＝新エンドポイントが結線済み。§9(c)の404ではない）
- `GET /api/v1/health` → **500**。原因は `.next/` の不整合で確定（`Cannot find module './682.js'`）。
  この無人実行で `npm run build` を流した際、起動中のdev serverと同じ `.next/` を上書きしたため。
  `app/api/v1/health/route.ts` は `NextResponse.json()` を返すだけで例外を投げ得ず、**コード側の欠陥ではない**。
  dev serverの再起動で解消する。実LB確認手順の §0 に注意書きとして追記した。

判定は **UI_UNVERIFIED のまま変わらない**。残作業は実Live Board確認（①〜④）のみ。
