# FireFlow / Live Board — Phase 1E-A1 currentPropertyId 永続化・起動時復元

実装日: 2026-08-18〜19
基準commit: `d763189 fix: hold outbox items without resolved property id`
判定: **PHASE1E_A1_PARTIAL**（実ブラウザ確認が未実施のため。自動検証はすべてPASS）

---

## 1. 目的

Phase 1E-A1が保証するのは「物件を切り替えられること」ではない。

> 一度決まった `currentPropertyId` を、reload / ブラウザ再起動後も
> 同じ値として安全に復元できること。

物件一覧UI・物件切替UI・`switchProperty()`・StampStore propertyId接続・
migration・新規物件作成UIは今回**実装していない**。

---

## 2. FIRST_USE（復元タイミング）

`currentPropertyId` が最初に使われる場所を実コードで追った結果：

| # | FIRST_USE候補 | 場所 |
|---|---|---|
| 1 | `var PROPERTY = { propertyId: window.getCurrentPropertyId() ... }` | index.html:4034 |
| 2 | `storageGet/Set/Delete/List` → `currentScopePropertyId()` | index.html |
| 3 | `flushOutbox()` | index.html |
| 4 | `ensureInspectionSession` / Realtime購読 / 写真パス / role / invite | supabase-integration.js（すべて `initSupabaseIntegration` 以降＝CDN onload後） |

`supabase-integration.js` は `<head>` 内の**defer/asyncなし同期スクリプト**として
index.html:1932 で読み込まれ、その IIFE 評価中に `currentPropertyId` が確定する。
上記1〜4はすべてその**後**に実行される。

→ 復元は **IIFE 内・setter定義直後の同期実行**に置いた。
CDN(supabase-js)の onload も DOMContentLoaded も待たない。
一度確定した後、この値を書き換える経路は追加していない。

---

## 3. 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `public/supabase-integration.js` | +49行。永続化キー・read/write・setterへの保存追加・起動時復元 |
| `public/test/phase1e_a1_current_property_persist_verify.js` | 新規。専用テスト142件 |
| `public/test/phase1a_property_id_verify.js` | 既存assertion 1件を更新（後述4章） |
| `package.json` | `test:release` に phase1a と phase1e_a1 を追加 |

**変更なし**: `public/index.html` / `stamp_store.js` / `schema.sql` /
`property_scope_migration.js` / DB / IndexedDB実データ。

---

## 4. 既存テストへの唯一の影響（重要・要承認事項）

`phase1a_property_id_verify.js` の

```
check('Phase 1Aではsetterを呼び出す経路がまだ無い（保存先・読込先が変化しない裏付け）',
  countOccurrences(sbjs, 'setCurrentPropertyId(') === 2, ...)
```

は「Phase 1Aの時点では setter を呼ぶ経路が1つも無い」という**フェーズ範囲の宣言**であり、
Phase 1E-A1（起動時復元 = 初めてのsetter呼び出し経路）とは論理的に両立しない。
仕様書の「§4 既存setterを唯一のsetterとして再利用」「§5 setCurrentPropertyId(savedId)を通す」を
満たす実装は、必ずこのassertionを破る（実装方法を問わない）。

そのため、この1件だけを**より強い不変条件**へ更新した：

- setter呼び出し経路は「定義」＋「起動時復元」の**1箇所だけ**（コメント除去後のコードで検査）
- その唯一の呼び出しは `restorePersistedPropertyIdAtStartup()` の中にある

Phase 1Aが本当に守っていた不変条件は、他のcheckでそのまま検査し続けている：
`currentPropertyId` への代入は宣言時＋setter内の**2箇所だけ** / setter定義は1つだけ /
index.html からは呼ばれない / INITIAL_PROPERTY_ID は不変 / 保存キー形式差分0。

他の既存テストの期待値は**1件も変更していない**（Phase 1A 48→49件へ増加、他は全件同数PASS）。

---

## 5. lb_current_property_id

- キー: `lb_current_property_id`
- 保存先: **localStorage**（IndexedDB / kv_store ではない）
- 理由: kv_store へ置くと「currentPropertyIdを知るためにcurrentPropertyIdが要る」循環依存になる
- 位置づけ: 業務データではなく**端末のUI設定**。property scope（`isPropertyScopedKey`）の**対象外**
- 業務データの正本は従来どおり Supabase `properties.id`。新しい業務正本は作っていない
- 定義は supabase-integration.js の1箇所のみ。index.html はこのキーを知らない

---

## 6. setCurrentPropertyId（唯一のsetter）

```js
function setCurrentPropertyId(propertyId) {
  if (!isValidPropertyId(propertyId)) return false;
  currentPropertyId = propertyId;
  persistPropertyId(propertyId);
  return true;
}
```

- UUID v4 / lowercase / 36文字のみ受理（`isValidPropertyId`、Phase 1Aから不変）
- null / undefined / 空文字 / 大文字UUID / 桁違い / v4以外 / variant不正 / 前後空白 / 数値 / オブジェクトを拒否
- 不正値では**現在値を破壊せず、localStorageへも書かない**（`false` を返すだけ）
- 保存は検証通過後にだけ行う

---

## 7. 起動時復元

```js
(function restorePersistedPropertyIdAtStartup() {
  var saved = readPersistedPropertyId();
  if (!isValidPropertyId(saved)) return;
  setCurrentPropertyId(saved);
})();
```

- 有効UUIDなら setter を通して採用
- 無い / 空 / 不正なら**何もしない**（＝`INITIAL_PROPERTY_ID` のまま起動）
- 「不正だから別物件にする」フォールバックは作っていない
- `removeItem` / `clear` は呼ばない（端末の他の設定を消さない）

---

## 8. INITIAL_PROPERTY_ID の扱い（今回の判断）

**完全廃止は Phase 1E-A2以降へ DEFER。**

今回入れたのは「localStorageに有効IDがあればそれを優先」まで。理由：

- Phase 1E-A1だけで既存のLB起動挙動を壊さないことが絶対条件（仕様§6）
- 保存が無い＝初回起動は従来と完全に同一（`b6e18eed-...` で起動）
- **保存が無いときに INITIAL_PROPERTY_ID を localStorage へ書き込むことはしない**。
  書いてしまうとデモ物件IDが端末設定として固定化され、DEMO_PROPERTY_IDへの降格が難しくなる
- したがって A2/A3 で DEMO_PROPERTY_ID へ降格する際、端末に残る不要データは無い

---

## 9. PROPERTY.propertyId

`index.html:4034` の `propertyId: window.getCurrentPropertyId()` は**変更していない**。
復元後の `currentPropertyId` がそのまま `PROPERTY.propertyId` になる（派生値）。
新しい正本にはしていない。専用テストGで、保存あり/なし/不正の3ケースすべてについて
`PROPERTY.propertyId === getCurrentPropertyId()` を実評価で確認済み。

---

## 10. localStorage障害

`readPersistedPropertyId()` / `persistPropertyId()` の両方を try/catch で保護。
新しい Storage adapter は作っていない。

| 障害 | 挙動 |
|---|---|
| `getItem` が throw（Safariプライベートモード等） | 起動継続。`INITIAL_PROPERTY_ID` を維持 |
| `setItem` が throw（quota等） | 起動継続。setterは `true` を返し**メモリ上の値は維持**。再試行しない（無限ループ0） |
| `window.localStorage` 自体が無い | 起動継続。`INITIAL_PROPERTY_ID` を維持 |
| 両方 throw | 起動継続 |

いずれの場合も**別のpropertyIdへフォールバックしない**。例外は呼び出し側へ伝播しない。

---

## 11. logout / login リスク（DEFER判断とその根拠）

**削除ロジックは実装せず、Phase 1E-A2へDEFER。**

- 実コードを確認したところ、現在の Live Board には **`sb.auth.signOut()` を呼ぶ経路が1つも存在しない**
  （`signOut` の出現0件）。フックを掛ける場所自体が無い
- Phase 1E-A1時点で `setCurrentPropertyId()` を呼ぶ製品経路は**起動時復元だけ**であり、
  物件切替UIが無いため、通常操作で `INITIAL_PROPERTY_ID` 以外が保存されることはない
- 別ユーザーが同じMac/browserを使ったときに前ユーザーの `lb_current_property_id` が残る問題は、
  **物件切替UI（A2）と同時に対処しなければならない**

**RLSでアクセス不可なpropertyIdを保持した場合の挙動（監査結果）**：
`kv_store` のRLSにより、そのユーザーには行が1件も見えない。結果として
「エラーにはならないが、業務データが空に見える」状態になる。書き込みもRLSで拒否され、
outboxに滞留する。**自動で別物件へ切り替わることはない**（推測での物件切替は入れていない）。
A2で「listMyProperties に含まれないpropertyIdは復元しない」チェックを入れるのが正しい対処。

---

## 12. feature flag / outbox / StampStore / migration

- `PROPERTY_SCOPE_ENABLED` は既定OFFのまま。今回ONにしていない
- flag OFF時の業務保存キーは Phase 1E-0 までと完全に同一。
  復元値が INITIAL / A / B のどれであっても、9種の業務キーの生成結果が1文字も変わらないことをテスト済み（H）
- outbox: Phase 1E-0 の安全化は無傷。propertyId無しの旧outbox3件は、
  復元後の currentPropertyId が何であっても **送信0 / 削除0 / 書換0**（I）。
  `item.propertyId` を持つitemは、復元値と異なっていても `item.propertyId` へ送られる
- StampStore: `stamp_store.js` 差分0（propertyId / getCurrentPropertyId / lb_current_property_id をいずれも含まない）
- migration: 実行0。Phase 1D dry-run結果（MIGRATABLE=0 / UNKNOWN_PROPERTY=15 / StampStore=259 /
  outbox NEEDS_USER_ASSIGNMENT=3）は一切変更していない

---

## 13. テスト結果

| 対象 | 結果 |
|---|---|
| phase1e_a1_current_property_persist_verify（新規・A〜L） | PASS 142/142 |
| phase1a_property_id_verify | PASS 49/49 |
| phase1b_property_state_reset_verify | PASS 75/75 |
| phase1c_property_scope_verify | PASS 151/151 |
| outbox_no_data_loss_verify | PASS 78/78 |
| phase1e0_outbox_property_safety_verify | PASS 110/110 |
| phase1d_property_scope_migration_dry_run_verify | PASS 94/94 |
| phase1d_real_device_dryrun_page_verify | PASS 64/64 |
| index_html_phase1_fix_test / sensor_master / room_roster / ocr系 | 全PASS |
| `npm run test:unit` | 全PASS |
| `npm run test:release` | 全PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |

localhost配信確認: `index.html` 200 / `supabase-integration.js` 200、
配信されたJSに `lb_current_property_id` と `restorePersistedPropertyIdAtStartup` を確認済み。

---

## 14. 残課題

- **実ブラウザ確認が未実施**（自動ブラウザ実行手段が無いため）。§17の手順は帰宅後に人手で実施
- logout時の `lb_current_property_id` クリア → A2
- listMyProperties に含まれないpropertyIdの復元拒否 → A2
- INITIAL_PROPERTY_ID の DEMO_PROPERTY_ID 降格 → A2/A3
- `public/test/_probe_sbjs_eval.js`（使い捨ての調査用スクリプト、中身は空）は削除してよい

---

## 15. 次

実ブラウザ確認がPASSしたら **PHASE1E_A2_GO**。
未確認の状態では A2 へ進まない。
