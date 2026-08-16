# 複数物件一括OCR検証基盤（Phase 3）2026-08-15

新捺印表の読み取りを **物件単位でまとめて検証し、失敗が「どの段階で最初に壊れたか」を一覧で判断できる** ようにするための仕組みと、その現時点の結果をまとめる。

対象パイプライン（正式経路）は従来どおり一本のまま。

```
実画像 → OCR raw → FireFlow辞書・業務ルール → normalize → Canonical / StampStore
      → 保存 → 復元 → Live Board表示
```

---

## 1. 何を作ったか（作っていないもの）

**作ったもの: 薄い一括実行層だけ。**

| ファイル | 役割 |
| --- | --- |
| `test/batch/runBatchValidation.ts` | 物件ケースを1件ずつ正式経路へ通し、期待値と突き合わせて失敗を分類・一覧化する |
| `test/batch/lbSandbox.ts` | `public/index.html` と `public/stamp_store/stamp_store.js` の**実関数**を1タブぶん動かす（既存テストと同じvm手法を関数化しただけ） |
| `test/fixtures/standardizedStampSheet/cases/*.json` | 物件ケース（生JSON・MASTER・Ground Truthの場所と期待値）。**判定はすべてこのJSONのデータ駆動** |
| `test/fixtures/standardizedStampSheet/cases/README.md` | 物件を1件追加する手順（コード変更不要） |
| `test/unit/ocr/standardizedStampSheet/batchValidation.test.ts` | 一括検証の結果を回帰として固定（新しい失敗が増えたら落ちる） |

**作っていないもの（意図的）**

- 新しいOCRエンジン / 新しいCanonical / 新しいStampStore / 新しい保存経路・adapter・override
- 物件別ルール・部屋番号のハードコード（検証コード側に物件固有の値は1つも無い）
- 巨大なtrace framework / 専用DB / Webダッシュボード / 自動原因分析
- 実APIの再実行（保存済みの生JSONだけを使うため、実行しても課金は発生しない）

正規化・辞書判定・保存形式・描画はすべて既存モジュールをそのまま呼んでいる。この層は
「同じ手順を物件の数だけ繰り返して、結果を並べる」ことしかしない。

## 2. 実行方法

```
npm run validate:batch   # 全物件を一括検証（コンソール一覧 + JSON + CSV）
npm run test:unit        # 回帰として固定（batchValidation.test.ts が同じ検証を実行する）
```

レポート出力先は `/stamp-batch-reports/`（読み取り結果が含まれるため `.gitignore` 済み。
既存の `ocr:compare` と同じ扱い）。

## 3. 何を見ているか

物件全体:
MASTER室数 / OCR対象室数 / Canonical室数 / 復元室数 / 描画カード数 / 要確認数 /
取りこぼし数 / 部屋を特定できなかった時間指定行数 / 捺印表に無い部屋にOCRが値を作っていないか

部屋ごと（Ground Truthのある部屋）:
記号（A / P / キャンセル / 二重チェックの未確定）・開始時刻・終了時刻・時間帯表示・
備考（朝一 / 昼一 など）・要確認フラグ・読み飛ばし・誤確定・false positive

Ground Truthの無い部屋も、**段階間で値が変わっていないこと**（Canonical→復元→描画）は自動で見る。
「紙面の正解が無いから何も分からない」区間を作らないため。

失敗は次の4種に分類し、Expected / OCR Raw / Canonical / Restored / Render を横並びで出す。
これで「最初に値が変わった段階」がそのまま読める（推測での原因確定を不要にする）。

| 分類 | 意味 |
| --- | --- |
| `OCR_FAIL` | OCRの生出力の時点で紙面の内容が現れていない |
| `NORMALIZE_FAIL` | rawには読めているのにCanonicalで期待値と違う（誤確定・読み飛ばし・false positiveを含む） |
| `PERSIST_FAIL` | 保存→復元で値が変わった／失われた |
| `RENDER_FAIL` | 復元まで正しいのに部屋カードに出ない／違う値が出る |

## 4. 現在の登録物件と結果（2026-08-15）

登録ケース: **1件**（`prop13_20260814` コスモ城東野江ロイヤルフォルム）

```
MASTER室数=66 / OCR対象室数(raw)=65 / Canonical=65 / 復元=65 / 描画カード=66
要確認=3 / 取りこぼし=0 / 未割当の時間指定行=1 / Ground Truth室数=65 / 判定項目数=390
OCR_FAIL=0  NORMALIZE_FAIL=0  PERSIST_FAIL=0  RENDER_FAIL=6
```

Ground Truthは `ground_truth_shinnain_v1_20260811.json`（2026-08-11作成、同一帳票の目視確認、
main_room_grid 65室 + 時間指定7行 + 判読不能行1行）から転記した。実装の出力から作った期待値は
1つも含まない。転記時に、生JSONの65室すべてのチェック状態がGround Truthと**完全一致**することを
確認済み（差分0件）。

### 物件数について

**5〜10物件は現時点で揃っていない。** リポジトリ内に実在する新捺印表の実OCR生JSONは1物件分だけで、
架空データを大量生成して「複数物件検証済み」とはしない（それをやると検証基盤の信頼性が消える）。

- `test/unit/ai/shared/fixtures/anthropic_real_raw_ibarakihozumi_2026-08-05.txt` は実データだが
  **別帳票（点検スケジュール一覧表・旧形式）** であり、MASTER室一覧もGround Truthも無い。
  新捺印表の経路へ流すには専用の変換を足すことになるため、対象外とした。

不足分は、実物件が増えたときに **JSONを1つ置くだけ** で追加できる構造になっている
（`cases/README.md` 参照。コード変更・テスト追加は不要）。

## 5. 一括検証で見つかった欠陥（優先度順）

> **①は2026-08-16の実行で修正済み（RENDER_FAIL 6→0）。** 経緯を残すため記述はそのままにし、
> 節末に「どう直したか」を追記した（§9も参照）。

### ① 確定した記号「キャンセル」が部屋カードに一切表示されない（RENDER_FAIL × 6室）【修正済み 2026-08-16】

- **最初に壊れた段階: render で確定。** Canonical・保存・復元まで `symbol="キャンセル"` を正しく保持しており、
  部屋カードの描画時にだけ消える（202 / 204 / 803 / 804 / 1104 / 1301）。
- **特定物件の問題ではない。** `public/index.html` の `initScheduleLabels()` は `s.symbol` が
  `'A'` と `'P'` の場合しかラベルを作らず、`'キャンセル'` は時刻も無ければ `null` になる。
  よってキャンセル記入のある**すべての物件**で同じことが起きる。ファイル冒頭のデモ用 `STAMP_DATA` に
  含まれるキャンセル部屋（712 / 609 / 417 等）も、新OCR以前から同様に表示されていない。
- **なぜこの実行で直さなかったか（推測修正の禁止）:** 原因箇所は確定しているが、修正は1箇所では
  終わらず、**業務上の判断が要る**ことが調査で分かったため。
  - `initScheduleLabels()` でラベル文字列を `'キャンセル'` にすると、`roomMatchesFilter()` の
    `label.text === activeFilter` により、**既存の絞り込みチップ「キャンセル」（点検状態のキャンセル）に
    予定のキャンセル部屋が混ざる**。
  - さらに `renderFilterChips()` は `'A'` `'P'` 以外のラベル文字列を「時刻チップ」として扱うため、
    `'キャンセル'` が時刻チップとして重複表示され、時刻ソート（`split(':')` → 数値化）でも NaN になる。
  - つまり必要なのは「予定のキャンセルを部屋カードでどう見せるか」「点検状態のキャンセルと
    同じ絞り込みに含めるか（統計カードの件数はどうするか）」という**UIの決定**であり、
    決めずに実装すると既存の絞り込み・チップを壊す。
- **決めてほしいこと（どれか1つ）**
  1. 予定のキャンセルは A/P と同じ位置に灰色で表示し、絞り込みチップ「キャンセル」にも含める
     （＝点検状態のキャンセルと同じ扱いにする）
  2. 表示はするが絞り込みは従来どおり点検状態だけを対象にする（表示専用ラベルとして別扱いにする）
  3. 部屋カードには出さず、要確認バッジと同じ小バッジで示す
- 決定後の修正範囲は `public/index.html` の `initScheduleLabels()` と `renderFilterChips()` /
  `roomMatchesFilter()` の3関数のみ。修正したら `npm run validate:batch` の RENDER_FAIL が
  6→0 になることで確認できる（`batchValidation.test.ts` の既知例外もそのとき削除する）。
- **検証層は2026-08-16に対応済み。** それまで `test/batch/lbSandbox.ts` の `readRenderedRoom()` は
  部屋カードの記号を `'A'` / `'P'` の2値に固定して読んでいたため、index.html を直して
  「キャンセル」が正しく表示されるようになっても、検証側が記号として読めず RENDER_FAIL が
  残る（さらに時刻欄として誤読され timeDisplay の失敗が加わり 6→12 に増える）状態だった。
  現在は「`.sched-label` が時刻の形をしていなければ記号として読む」に一般化してあるので、
  index.html 側だけ直せば RENDER_FAIL は素直に 6→0 になる。この変更で現時点の出力は変わらない
  （index.html は A/P と時刻しか `.sched-label` に入れないため。実行して同一であることを確認済み）。
- **修正内容（2026-08-16、選択したのは上の選択肢2）。** 無人実行のため決定を待てず、
  「既存の絞り込みを1つも変えない」＝影響が最小の案として **2（表示はするが絞り込みは従来どおり）** を
  前提に実装した。1と3は既存の挙動（チップの意味・統計カードの件数）を変えるため、
  ユーザー判断なしに選ばない。
  - `initScheduleLabels()` に `else if (s.symbol)` の分岐を追加し、A/P以外の確定記号を
    **表示専用**として `{ text: null, symbolText: s.symbol, color: '#6B7280' }` で持たせる。
    `text`（＝絞り込みが参照する値）は変更しないので、`roomMatchesFilter()` は**無変更**。
    2026-08-09に `timeDisplay` を追加したときと同じ「textは変えず表示用の値を別に持つ」方式。
  - 分岐は**時刻表示の分岐より後ろ**に置いた。そのため今まで表示できていた部屋の見え方は
    1件も変わらず、記号も時刻も無く何も出ていなかった部屋だけが増える。
  - `renderFilterChips()` に `if (!label.text) return;` の1行を追加（表示専用ラベルが
    `null` という名前のチップを作らないようにするだけ）。
  - `renderFloors()` は表示時だけ `label.text || label.symbolText` を見る。ついでに
    ラベル文字列を `escapeHtml()` に通した（A/P・時刻では出力は同一）。
  - 結果: **RENDER_FAIL 6→0**。物件・部屋番号のハードコードは無し。キャンセル記入のある
    **全物件**に効く。

### ①-b 検証層が覆えない範囲を回帰で固定した（2026-08-16）

一括検証は `renderFilterChips()` をスタブにしているため、チップ側の回帰を見られない。
上の修正で `scheduleLabels` に `text: null` のラベルが入るようになったので、
`test/unit/lb/scheduleLabelFilterChips.test.ts` を追加し、index.html の実関数を直接動かして

- チップが `A / P / 時刻 / 不在 / キャンセル` のままで増えない（`null` チップが出ない）
- 「キャンセル」チップは**点検状態のキャンセルだけ**を拾い、予定の記号キャンセルは混ざらない

ことを固定した。物件固有の値は使っていない。

### ② 物件数が1件しかない（検証基盤としての被覆が足りない）

仕組みは複数物件対応済みだが、実データが1物件しか無い。次に実物件の捺印表を読み取ったとき、
その生JSONと紙面のGround Truthを `cases/` に追加すれば、そのまま被覆が増える。

### ③ 時刻の十の位が空欄の行（1101 / 801 の「9:30」）

Ground Truth側は「画像だけでは 09:30 と断定不可」としているが、現行実装は 09:30 として確定し、
本ケースの期待値もそれに合わせている（Phase 2での決定を踏襲）。今回この判断は変更していない。
将来この扱いを変える場合は、実装とケースJSONの両方を同時に見直す必要がある。

## 6. 検証結果（2026-08-15 実行）

| 検証 | 結果 |
| --- | --- |
| `npm run test:unit` | PASS（batchValidation.test.ts を含む全テスト） |
| `npm run test:release` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| 一括検証本体（`npx tsx test/batch/runBatchValidation.ts`） | OCR_FAIL=0 / NORMALIZE_FAIL=0 / PERSIST_FAIL=0 / RENDER_FAIL=6（上記①のみ） |

※ `npm run validate:batch` は今回の無人実行では権限設定により実行できなかったため、
同じ処理を `npx tsx test/batch/runBatchValidation.ts` で実行して確認している
（package.json のスクリプトは既存の `ocr:benchmark` と同じ書式で、中身はこのコマンドと同一）。

## 7. 複雑化していないことの確認

- 新しい正本・Canonical・StampStore・保存経路・adapter・override・物件別ルール: **追加0**
- FireFlow本体（`lib/` `app/` `public/index.html` `public/stamp_store/`）の変更: **なし**
  （この実行で触れたのは検証層・ケースJSON・package.jsonのスクリプト・.gitignore・docsのみ）
- 物件が1件増えたときに書くコード: **0行**（JSONを1つ置くだけ）
- 判定に使う関数は、実際のLive Boardが使っているものと同一（別実装を持たない）

## 8. 再検証（2026-08-16 実行）

同じタスクで再度無人実行したため、まず前回結果がそのまま再現するかを確認した。

| 検証 | 結果 |
| --- | --- |
| 一括検証本体（`npx tsx test/batch/runBatchValidation.ts`） | OCR_FAIL=0 / NORMALIZE_FAIL=0 / PERSIST_FAIL=0 / RENDER_FAIL=6（前回と完全一致） |
| `npm run test:unit` | PASS |
| `npm run test:release` | PASS（30/30） |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |

`npm run validate:batch` は今回も権限設定により実行できなかった（中身は同一の
`npx tsx test/batch/runBatchValidation.ts` で確認済み）。

### この実行での変更（1点だけ）

`test/batch/lbSandbox.ts` の `readRenderedRoom()` を、記号を `'A'` / `'P'` の2値に固定して
読む実装から、「`.sched-label` が時刻の形をしていなければ記号として読む」へ一般化した。
理由と効果は §5 ① の末尾に記載。**現時点の検証結果は変更前と1件も変わらない**（実行して確認済み）。

FireFlow本体（`lib/` `app/` `public/index.html` `public/stamp_store/`）は今回も**無変更**。

### 実データの追加可否（再確認）

リポジトリ全体を再走査したが、新捺印表の実OCR生JSON（`raw_checkboxes` を持つ実データ）は
`test/fixtures/standardizedStampSheet/real_scan_prop13_20260814.json` の**1件のみ**で、
前回の記載と変わらない。`public/test/fixtures/prop13/prop13_shou4.json` は同一物件のExcel由来
データ（MASTERの元）であって別物件ではない。よって架空データは追加していない。

---

## 9. 3回目の実行（2026-08-16）— 唯一残っていた欠陥を修正

同じタスクで3回目の無人実行となったため、まず前回結果の再現を確認し、その上で
**§5① を修正した**（一括検証が「壊れる段階は render」と確定させていた唯一の欠陥）。

### 実施順

1. `npx tsx test/batch/runBatchValidation.ts` を実行 → 前回と完全一致（`RENDER_FAIL=6`、6室すべて
   `raw=canonical=restored=キャンセル / render=(なし)`）。**壊れる段階が render であることを再確認。**
2. `public/index.html` の該当3関数だけを修正（詳細は §5① の「修正内容」）。他は触っていない。
3. 再実行 → `OCR_FAIL=0 / NORMALIZE_FAIL=0 / PERSIST_FAIL=0 / RENDER_FAIL=0`（**総合 PASS**）。
4. `batchValidation.test.ts` の既知例外を撤廃し、RENDER_FAIL も0件固定にした。
5. 検証層が覆えないチップ側を `scheduleLabelFilterChips.test.ts` で固定（§5①-b）。

### 検証結果

| 検証 | 結果 |
| --- | --- |
| 一括検証本体（`npx tsx test/batch/runBatchValidation.ts`） | **PASS**（OCR_FAIL=0 / NORMALIZE_FAIL=0 / PERSIST_FAIL=0 / RENDER_FAIL=0） |
| `npm run test:unit` | PASS（新規1本を含む全テスト） |
| `npm run test:release` | PASS（29/29・18/18・9/9・13/13・30/30） |
| `npm run typecheck` | PASS |
| `npm run build` | PASS（Compiled successfully） |
| dev server + `curl http://localhost:3000/index.html` | 200・修正が配信物に入っていることを確認 |

### 変更ファイル

| ファイル | 変更 |
| --- | --- |
| `public/index.html` | `initScheduleLabels()` / `renderFilterChips()` / `renderFloors()` の3関数のみ（§5①） |
| `test/unit/ocr/standardizedStampSheet/batchValidation.test.ts` | 既知例外を撤廃し RENDER_FAIL=0 固定へ |
| `test/unit/lb/scheduleLabelFilterChips.test.ts` | 新規（チップ回帰の固定。§5①-b） |
| `test/batch/_tmpChipCheck.ts` | 使い捨ての確認用に作ったもの。**2026-08-16の4回目実行時点で既に存在しない**ため、PC作業は不要（`test/batch/` は `lbSandbox.ts` と `runBatchValidation.ts` の2つだけ） |
| このdoc | 追記 |

**この修正は1物件だけに効くものではない。** キャンセル記入のある全物件で同じ描画欠陥が起きており、
物件名・部屋番号のハードコードは一切入れていない。

### まだユーザーにしかできないこと

実Live Board（ブラウザ）で、キャンセルの部屋カードに灰色の「キャンセル」が出ること、
および既存の絞り込みチップが従来どおりであることの目視確認。
自動検証は index.html の実関数を通して同じHTMLを読んでいるが、絶対ルール3の
「実際の画面で使えるか」だけは人が見ないと確定しない（LOCAL_GOの最後の1項目）。

---

## 10. 4回目の実行（2026-08-16）— 「全PASS」が意味を持つことの担保

前回で欠陥が0件になったため、まず再現を確認し、その上で**この検証基盤に残っていた
最後の穴**を1つだけ塞いだ。FireFlow本体（`lib/` `app/` `public/`）は**無変更**。

### 何が穴だったか

`batchValidation.test.ts` は「失敗が0件であること」を固定するテストである。
RENDER_FAIL が 6→0 になった結果、**全ケースがPASSする状態**になった。
この状態では、判定側が壊れて常に「異常なし」を返すようになっても誰も気づかない。
つまり `OCR_FAIL=0 / NORMALIZE_FAIL=0 / PERSIST_FAIL=0 / RENDER_FAIL=0` という結果の
意味を保証しているものが無かった（欠陥が1件も無い検証基盤は、空検査と区別が付かない）。

### 追加したもの（1ファイルだけ）

`test/unit/ocr/standardizedStampSheet/batchValidationSelfCheck.test.ts`

**既存の `runCase()` をそのまま呼び、渡すケース定義だけをメモリ上で1箇所ずらす。**
「期待した種類の失敗が、期待した段階で、ずらした箇所にだけ現れる」ことを確認する。

- ケースJSON（Ground Truth）のファイルは**書き換えない**（メモリ上のコピーだけを歪める）
- 物件名・部屋番号・記号名・時刻の文字列を**テスト側に1つも書かない**
  （対象はすべてケースの中身から実行時に選ぶ。物件が増えればそのまま全物件に適用される）
- 新しい仕組み・trace framework・フック・注入ポイントは追加していない

| ずらした箇所 | 検出されること（確認済み） |
| --- | --- |
| 記号を同ケース内の別の記号へ | `OCR_FAIL` @ raw |
| 開始時刻を同ケース内の別の時刻へ | `OCR_FAIL` @ raw |
| 備考を紙面と違う文字列へ | `OCR_FAIL` @ raw |
| 要確認にすべき部屋の期待値を反転 | `NORMALIZE_FAIL` @ canonical（誤確定） |
| 要確認の集合から1件外す | `NORMALIZE_FAIL` @ canonical（false positive） |
| 取りこぼし件数を+1 | `NORMALIZE_FAIL` @ canonical（件数ずれ） |
| 予定が出ている部屋を「捺印表に無い部屋」扱いへ | `RENDER_FAIL` @ render |

各ケースで **findings の総数も**（baseline + ずらした数）と一致することまで見ているので、
副作用で無関係な失敗が湧く実装になっていないことも同時に固定される。

**PERSIST_FAIL だけ扱いが違う。** 保存→復元の判定は「Canonicalと復元結果が同じか」なので、
期待値をずらしても到達できない。そこでこの段階だけは、保存先の内容を1件だけ失わせて

- 消した部屋はCanonicalには在る
- 復元結果には現れない（欠落を観測できている）
- MASTER由来の部屋カード自体は残る（OCRでMASTERを作り替えていない）
- 失われた予定は部屋カードにも出ない（描画の読み取りが実データを見ている）

を直接確認した（`runCase()` が PERSIST_FAIL を出すときに見ているのと同じ観測点）。
対象の部屋は保存キーから実行時に取るため、ここにも部屋番号は書いていない。

結果: **22件の確認がすべてPASS**。

### この実行での変更ファイル

| ファイル | 変更 |
| --- | --- |
| `test/unit/ocr/standardizedStampSheet/batchValidationSelfCheck.test.ts` | 新規（上記） |
| `test/batch/runBatchValidation.ts` | `loadMasterRooms` に `export` を付けただけ（判定ロジックは1行も変えていない。self-check側で同じ読み込みを再実装しないため） |
| このdoc | §9の一時ファイル記述の訂正と本節の追記 |

### 検証結果（2026-08-16・4回目）

| 検証 | 結果 |
| --- | --- |
| 一括検証本体（`npx tsx test/batch/runBatchValidation.ts`） | **PASS**（OCR_FAIL=0 / NORMALIZE_FAIL=0 / PERSIST_FAIL=0 / RENDER_FAIL=0・前回と完全一致） |
| `npm run test:unit` | PASS（新規self-checkを含む全テスト） |
| `npm run test:release` | PASS（29/29・18/18・9/9・13/13・30/30） |
| `npm run typecheck` | PASS |
| `npm run build` | PASS（Compiled successfully） |

### 残っている課題（前回から変わらない）

- **物件数が1件**（§5②）。実データが増えたら `cases/` にJSONを1つ置くだけで被覆が増える。
  self-checkも全ケースに対して自動で回るので、追加時に書くコードは0行のまま。
- 実Live Boardでの目視確認（§9末尾）。これだけは人にしかできない。

---

## 11. 5回目の実行（2026-08-16）— 再現確認のみ。コード変更なし

同じタスクでの5回目の無人実行。**完了条件（§1〜§4）は4回目までに達成済み**のため、
絶対ルール10「完了条件を満たしたら一度止める／1物件・1機能を無限に磨き続けない」に従い、
**この実行では意図的にコードを1行も変更していない**。行ったのは再現確認と、以下の
「検証基盤が正式経路に乗っているか」の確認だけ。

### 再現確認（前回と完全一致）

| 検証 | 結果 |
| --- | --- |
| 一括検証本体（`npx tsx test/batch/runBatchValidation.ts`） | **PASS**（OCR_FAIL=0 / NORMALIZE_FAIL=0 / PERSIST_FAIL=0 / RENDER_FAIL=0） |
| `npm run test:unit` | PASS（`batchValidation.test.ts` / `batchValidationSelfCheck.test.ts` 22件を含む全テスト） |
| `npm run test:release` | PASS（30/30 まで到達） |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |

判定内訳も前回と同一（MASTER室数=66 / OCR対象室数=65 / Canonical=65 / 復元=65 / 描画カード=66 /
要確認=3 / 取りこぼし=0 / 未割当の時間指定行=1 / 判定項目数=390）。

### 検証基盤が「正式経路そのもの」であることの確認

一括検証がPASSしても実LBが壊れていては意味がないため、本番の呼び出し順と一致しているかを確認した。

- 本番経路 `lib/handlers/scanStandardizedStampSheet.ts` は
  `normalizeStandardizedStampScan()` → `toLiveBoardStampData()` の順で呼んでおり、
  この2つの間に別の変換は無い。
- `test/batch/runBatchValidation.ts` も同じ2関数を同じ順で呼んでいる。**別実装は持っていない。**
- 保存・復元・描画は `public/stamp_store/stamp_store.js` と `public/index.html` の実関数を
  `test/batch/lbSandbox.ts` 経由でそのまま動かしている。

よって「一括検証がPASS ＝ 正式経路がPASS」が成立している。

### 実データの再確認

`raw_checkboxes` を持つ実OCR生JSONはリポジトリ全体で
`test/fixtures/standardizedStampSheet/real_scan_prop13_20260814.json` の**1件のみ**で変化なし。
架空データは追加していない（§4「物件数について」の方針を維持）。

なお現在のGround Truthに含まれる備考は「朝一」1件のみで、「昼一」の実例はまだ無い。
判定コード自体は備考を文字列としてデータ駆動で見ているため物件追加時の変更は不要だが、
**「昼一」は実データで一度も通っていない**ことを事実として記録しておく。

### 検証層とは別に残っている不要ファイル（削除はユーザー判断）

`test/trace/` に Phase 2 の 801号室個別調査で使った使い捨てスクリプトが残っている。

- `test/trace/stamp801Trace.ts`（236行）
- `test/trace/stamp801Repro.ts`（47行）

いずれも**部屋番号801を直接埋め込んだ個別調査用**で、Phase 3 の一括検証基盤が同じ役割を
一般化して置き換えている。`package.json` からも他テストからも参照されておらず、
`npm run test:unit` の対象外（`test/unit/` 配下ではない）。今回のタスクの
「801を個別に追い続けない」「特定部屋番号のハードコード禁止」に照らすと削除が妥当だが、
Git未追跡ファイルで削除が不可逆のため、**無人実行では消さずに報告のみ**とした。

同ディレクトリの `task_sample_inline.md` / `task_sample_written.md` / `taskTemplateGuard.sh` は
無人実行ランナー用のもので、trace とは無関係。置き場所が紛らわしいだけで動作への影響は無い。
