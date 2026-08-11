# CURRENT_STATUS

（このファイルは現在状態のスナップショットのみ。過去履歴は蓄積しない。詳細な経緯はKnowledge Base・個別報告書を参照）

- **last_updated**: 2026-08-11
- **knowledge_base_version**: Ver1.22 (`FireFlow_Knowledge_Base_Ver1.22_2026-08-11.md`)
- **active_project**: Live Board（FireFlow）
- **current_phase**: 新捺印表OCR — 実Anthropic API抽出精度検証フェーズ（BLOCKED）
- **current_focus**: 新捺印表OCR 実Anthropic API抽出精度検証
- **latest_completed**: 新捺印表OCR 正規化ロジックの実物サンプル検証（`FireFlow_新捺印表OCR_実物検証_2026-08-11.md`）。false positive = 0を確認。room_grid/time_grid/qr_code_areaの座標実測完了
- **production_state**: NOT_IN_PRODUCTION（新捺印表OCR経路はLive Board本番未接続）
- **release_state**: TESTED（新捺印表OCR正規化ロジック・handoff基盤ともにローカルテスト済み。PUSHED_TO_MAIN未満）
- **next_gate**: 実Anthropic APIによるOCR抽出精度検証（`ANTHROPIC_API_KEY`未設定のためBLOCKED。`handoff/BLOCKERS.md`参照）
- **known_risks**:
  - 新捺印表OCRのAI Vision抽出精度（1003/405号室のような誤読）は未検証（正規化ロジックの正しさのみ確認済み）
  - 座標実測はサンプル1件のみに基づく。他物件・他スキャン条件での再現性はUNKNOWN
  - remarks_area（備考欄）は非連続な2列構造のため、現行のゾーン型では単一矩形として表現できていない（意図的にcalibrated:false）
  - **このセッションのワーキングコピー（`/tmp/fireflow/live-board-nextjs`）にはGitリポジトリが存在しない（`.git`無し、remoteも無し）。このhandoff/自体、実際のFireFlow GitHubリポジトリへはまだ反映されていない可能性がある。詳細は`handoff/BLOCKERS.md`のBLOCKER-002を参照**

## 新捺印表OCR（Standardized Stamp Sheet）機能の詳細ステータス

| 項目 | 状態 |
|---|---|
| P0実装（正規化ロジック・辞書・型定義） | COMPLETE_LOCAL、単体テスト47アサーション全PASS |
| 実物サンプルによる正規化ロジック検証 | COMPLETE_LOCAL、false positive = 0 |
| 802号室（A+P同時チェック）→ needs_review | 確認済み |
| 1005号室（P+キャンセル同時チェック）→ needs_review | 確認済み（実物確認で新規発見） |
| 805号室（P+キャンセル同時チェック）→ needs_review | 確認済み（実物確認で新規発見） |
| 1003・405号室 | 正しい中間値(`p_checked=true`)を与えた場合、Pへ正常収束することを確認済み。AI Vision自体がチェックボックスを正しく読み取れるかはUNKNOWN |
| symbol/time共存 | 確認済み（symbol確定後もtime_start/time_endは破棄されない） |
| room_grid / time_grid / qr_code_area 座標calibrated | true（実測値を`layoutRegistry.ts`に反映済み） |
| remarks_area 座標calibrated | false（意図的。非連続2列のため現行スキーマで単一矩形化不可） |
| 実Anthropic API OCR抽出精度検証 | 未実施（`ANTHROPIC_API_KEY`未設定のためBLOCKED） |
| LB本番（`lb_tool/index.html`）接続 | 未実施 |
| GitHub main push | 未実施 |
| Vercel production deploy | 未実施 |
