# DECISIONS（現在有効な重要判断の早見表）

（Knowledge Baseそのものを置き換えるものではない。KBは正式な長期知識、これは現在の重要判断の早見表。各decisionはKB内の該当Patternとリンクしている）

| decision_id | date | title | decision | reason | status |
|---|---|---|---|---|---|
| DEC-001 | 2026-08-08 | MASTER/DELTA境界 | MASTER（確定情報）とDELTA（差分・未確定情報）の境界を崩さない。既存のROOM ROSTER・SENSOR MASTER構築ロジックを変更しない | 過去物件分析（KB-001〜023）で確立した基盤。変更は既存14物件分の整合性を壊すリスクが高い | ACTIVE |
| DEC-002 | 2026-08-11 | 誤確定0優先 | OCR/正規化の設計判断において、誤確定（false positive）0を素の正答率より優先する。曖昧・辞書外は「要確認」に倒す | KB-024（新捺印表OCR誤確定ゼロ優先Operation Rule）のルール6 | ACTIVE |
| DEC-003 | 2026-08-11 | 読めない時刻を推測しない | 時間指定グリッドで判読不能・桁欠け・十の位空白等の場合、0埋めや推測補完を行わずneeds_reviewへ倒す | KB-024ルール6。実物検証（1101/801号室の十の位空白ケース）で安全側動作を確認済み | ACTIVE |
| DEC-004 | 2026-08-11 | 二重チェックはneeds_review | A/P/キャンセルのうち2個以上が同時にtrueの場合、単一symbolへ自動収束させず必ずneeds_reviewへ倒す | KB-024ルール2。802/1005/805号室の回帰テスト・実物検証で確認済み | ACTIVE |
| DEC-005 | 2026-08-11 | symbol/time共存 | symbolの値に関わらず、time_start/time_endは常にそのまま保持する（Legacy側の「symbol確定時にtime破棄」矛盾を新経路に持ち込まない） | KB-024・KB-018。設計書2026-08-11 Section 2.5で発見したLegacy側の既知の矛盾の再発防止 | ACTIVE |
| DEC-006 | 2026-08-11 | Legacyを壊さない | 新捺印表OCR経路（`standardizedStampSheet`）は、既存Legacy捺印表経路（`residentTimeRequestSheet.ts`）と完全に独立させる。既存ファイルの改変は追記のみ許可（`taskRouting.ts`等） | 既存14物件分のLegacy運用を止めないため | ACTIVE |
| DEC-007 | 2026-08-11 | GitHub main pushはユーザーGO後 | GitHub mainへのpushは、ユーザーの明示的なGOなしでは行わない | リリースガバナンス。誤って未検証コードを本番相当ブランチへ混入させないため | ACTIVE |
| DEC-008 | 2026-08-11 | Vercel Production deployもユーザーGO後 | Vercel本番デプロイは、ユーザーの明示的なGOなしでは行わない | 同上 | ACTIVE |
| DEC-009 | 2026-08-11 | fixed-layout座標はformat version単位管理 | 新捺印表のようなfixed-layout帳票の座標は、特定物件専用にhard-codeせず、`layout_format_id`（例：`standardized_stamp_sheet_v1`）単位で管理する | KB-024ルール5 | ACTIVE |
| DEC-010 | 2026-08-11 | 座標・閾値は複数サンプルで再現性確認するまで確定扱いしない | 実測値がサンプル1件のみに基づく場合、KB上は「実測済み」であっても「再現性未確認」と明記し続け、座標ベースの決定的ロジックの主経路化はまだ行わない | KB Ver1.22 新規運用ルール。実物検証報告書17章 | ACTIVE |

## status の定義

- `ACTIVE` — 現在も有効
- `SUPERSEDED` — 別の判断に置き換えられた（置き換え後の判断のdecision_idを備考に記載）
- `RETIRED` — もはや対象が存在しない等の理由で無効化された
