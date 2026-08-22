# request storm commit分離: 安全チェックの誤検知修正（2026-08-22）

`scripts/commit_request_storm.sh` が

```
NG: staging に Phase 1E-A1 が混ざっています。commit せずに中止しました。
```

で安全停止した件の原因確定と修正。**commit / push は未実施。**

---

## 1. 結論

**A1製品コードの混入は0件。安全チェックの誤検知だった。**

旧チェックはこう書かれていた（旧 `commit_request_storm.sh:75`）。

```bash
if git diff --cached | grep -n "lb_current_property_id\|restorePersistedPropertyIdAtStartup\|phase1e_a1_current_property_persist"; then
```

`git diff --cached` は **docs を含む staged diff 全体**である。
一方 request storm の docs は、まさに「A1は含めない」ことを説明するために
A1の識別子を本文へ書いている。そこに grep が反応していた。

誤検知させていた実際の記述（すべて storm docs の説明文）:

| ファイル | 記述の趣旨 |
|---|---|
| `docs/FireFlow_RequestStorm_Commit分離_2026-08-22.md:67,69,71,170,171,183,196` | 「A1側に何が入るか」「storm側に A1 の差分が1行も無い」の説明 |
| `docs/FireFlow_Outbox_RequestStorm_Fix_2026-08-22.md:317,373,465` | A1テストは手つかず／A1テストPASS(142/142)の記録 |
| `docs/FireFlow_Supabase_kv_store_500_Audit_2026-08-19.md:27,30,44,46` | 500調査時にA1の追加箇所を列挙した監査記録 |
| `docs/FireFlow_RequestStorm_AutoFix_Complete_2026-08-22.md:226,336` | A1テストPASS記録／A1は保護されている旨 |
| `docs/FireFlow_RequestStorm_RealBrowser_Audit_2026-08-22.md:336` | A1テストの `bootLiveBoard()` を流用した旨 |
| `docs/FireFlow_RequestStorm_Fix_2026-08-19.md:249` | A1テストPASS記録 |
| `docs/FireFlow_Supabase500_Fix_Design_2026-08-19.md:739` | A1の永続化に触れた設計記述 |

これらは**A1コードの混入ではなく、A1についての説明文**である。

---

## 2. 実測（strip後・A1を外した状態）

### 2-1. 製品コード・テストの storm diff における A1識別子

対象マーカー:
`lb_current_property_id` / `CURRENT_PROPERTY_STORAGE_KEY` /
`restorePersistedPropertyIdAtStartup` / `readPersistedPropertyId` /
`persistPropertyId` / `phase1e_a1_current_property_persist` / `phase1a_property_id_verify`

| 対象 | ヒット |
|---|---|
| tracked storm code 8ファイルの `git diff` の `^[-+]` 行 | **0** |
| 新規 storm テスト5ファイルの全文 | **0** |

### 2-2. `package.json` の storm staged diff

```
-    "test:release": "... room_roster_66_to_25_fix_verify.js && node public/test/phase1b_..."
+    "test:release": "... phase1e0_outbox_property_safety_verify.js
                      && node public/test/request_storm_fix_verify.js
                      && node public/test/stampstore_request_storm_fix_verify.js
                      && node public/test/stampstore_seed_storm_fix_verify.js
                      && node public/test/outbox_request_storm_fix_verify.js
                      && node public/test/page_wide_idle_request_verify.js
                      && node public/test/phase1d_..."
```

追加されるのは **storm用テスト5本だけ**。
`phase1a_property_id_verify` / `phase1e_a1_current_property_persist_verify` の
登録は入っていない（＝A1専用テストの登録は storm commit に混ざらない）。

### 2-3. `public/supabase-integration.js` の storm staged diff

42行の変更のうち、A1識別子を含む追加/削除行は **0**。
`CURRENT_PROPERTY_STORAGE_KEY` / `readPersistedPropertyId` / `persistPropertyId` /
`restorePersistedPropertyIdAtStartup` / A1のpersist処理は**1行も入らない**。

### 2-4. staged になるファイル集合（23件）

| 区分 | 件数 |
|---|---|
| tracked・変更あり（製品コード/テスト） | 8 |
| untracked・新規 storm テスト | 5 |
| untracked・新規 storm docs | 10（このファイルを含む） |

storm commit に**入らない**ことを確認した A1専用ファイル:

- `public/test/phase1e_a1_current_property_persist_verify.js`（untracked のまま）
- `docs/FireFlow_Phase1E_A1_CurrentPropertyPersist_2026-08-19.md`（untracked のまま）
- `public/test/phase1a_property_id_verify.js`（modified のまま・unstaged）

無関係差分として除外を維持:
`docs/FireFlow_StampBatchValidation_Phase3_2026-08-15.md` /
`public/test/_probe_*.js` / `docs/current_task.md.save`

---

## 3. 修正内容（必要最小限）

### 新規 `scripts/storm_commit_common.sh`（対象ファイルと判定の正本）

commit本体と dry-run が同じ定義を使うようにし、判定を2つに分けた。

- `STORM_CODE_PATHS`（13）… 製品コード・テスト。**A1識別子が1つでも出たらNG**
- `STORM_DOC_PATHS`（10）… docs。**識別子による混入判定の対象外**（説明文だから）
- `A1_ONLY_PATHS`（3）… storm commit に絶対入れてはいけないA1専用ファイル

docs を判定対象外にした分は、次の3つで守る。

1. `git add` は明示allowlistのみ（他のファイルは物理的に入らない）
2. staged file list に `A1_ONLY_PATHS` が無いこと
3. staged file list が想定23件と**完全一致**すること（多くても少なくてもNG）

さらに、
- 判定は diff の `^[-+]` 行だけを見る（context行の巻き込みを防ぐ）
- 「Phase 1E-A1」という日本語の説明文はマーカーに**入れない**

### `scripts/commit_request_storm.sh`

- 対象ファイル定義とチェックを common.sh へ移動
- ステップ3を 3-1(file list) / 3-2(製品コードのA1識別子) / 3-3(`git diff --cached --check`) に分割
- 各NGで `git reset` して中止する挙動は維持
- `node scripts/...` → `npx tsx scripts/...`（無人実行の permissions で `node <file>` が不可のため）

### 新規 `scripts/dryrun_request_storm_commit.sh`

`git add` / `commit` を一切せずに同じ判定を行う。
staging の代わりに「HEADとの差分」＋「未追跡ファイルの全文（`git diff --no-index`）」を
合成して、staged になる内容そのものを再現する。
終了時は必ず A1差分を restore する（trap EXIT）。

---

## 4. テスト結果

### storm-only（A1をstripした状態）

| 項目 | 結果 |
|---|---|
| `npm run test:release` | PASS（A1テスト2本は未登録なので走らない＝想定どおり） |
| `npm run test:unit` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS（Compiled successfully / 11 pages） |
| `git diff --check`（storm対象） | PASS |
| 新規storm 14ファイルの行末空白・CR | 0件 |

### A1復元後（現在のワーキングツリー）

| 項目 | 結果 |
|---|---|
| `npm run test:release` | PASS 全17本（`phase1a` 49/49・`phase1e_a1` 142/142・`request_storm` 79/79・`stampstore_request_storm` 59/59・`stampstore_seed_storm` 56/56・`outbox_request_storm` 59/59・`page_wide_idle` 69/69 ほか） |
| `npm run test:unit` | PASS（OK 802件） |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

### ワーキングツリーの同一性

strip → 検証 → restore を2回行い、そのつど sha256 が開始時と一致することを確認した。

```
MATCH package.json                                          8a0cf3b8f1d2aed0
MATCH public/supabase-integration.js                        e2e6f34d75dfd7f7
MATCH public/index.html                                     c48aea6d3189a164
MATCH public/stamp_store/stamp_store.js                     eb056540fdc0a855
MATCH public/test/phase1a_property_id_verify.js             554cb24741c4899c
MATCH public/test/phase1e_a1_current_property_persist_verify.js b09b9583bc67350a
```

`git status --short` も開始時と完全一致。index は空（staged 0件）。
`git reset --hard` / `git restore` / `git checkout` / `git stash` は一切使っていない。

---

## 5. 未実施（PCの前で行う）

`bash` は `.claude/settings.local.json` の allow に無いため、無人実行では
`bash scripts/dryrun_request_storm_commit.sh` を**起動できなかった**。
上記の判定はすべて、許可済みコマンド（`git diff` / `grep` / `python3` / `npx tsx`）で
1つずつ同じ内容を手実行して確認している。スクリプト自体の実行確認だけが残っている。

```
bash scripts/dryrun_request_storm_commit.sh    # DRY RUN OK が出ること
bash scripts/commit_request_storm.sh           # commit（push はしない）
npm run test:release                           # A1が戻った状態で全PASS
git push origin main
```

---

## 6. 状態

`REQUEST_STORM_COMMIT_SPLIT_READY`

commit / push は未実施。
