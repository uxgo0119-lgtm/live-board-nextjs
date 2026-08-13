# CURRENT_STATUS

- **last_updated**: 2026-08-13
- **knowledge_base_version**: Ver1.24
- **active_project**: Live Board（FireFlow）
- **current_phase**: 新捺印表OCR — GitHub正本統合完了 / GitHub反映後の再テスト待ち
- **current_focus**: `fireflow-ver1-completion`を実行環境でcheckoutし、unit/release再テスト後に実Anthropic API抽出精度検証へ進む
- **latest_completed**: P0実装＋実物検証差分＋Ground Truth＋回帰テスト一式を`fireflow-ver1-completion`へGitHub上で統合。ChatGPT側のGitHub接続から直接反映した
- **production_state**: NOT_IN_PRODUCTION（新捺印表OCR経路はLB本番未接続）
- **release_state**: GITHUB_INTEGRATED / SOURCE_PATCH_TESTED_BY_CLAUDE / GITHUB_RETEST_PENDING
- **next_gate**: (1) GitHub反映後のunit/release再テスト、(2) 実Anthropic APIによるOCR抽出精度検証
- **work_branch**: `fireflow-ver1-completion`
- **main_policy**: ユーザー明示GOまで変更禁止

## handoff状態

| 経路 | 状態 |
|---|---|
| ChatGPT → GitHub読み取り | VERIFIED |
| ChatGPT → `fireflow-ver1-completion`書き込み | VERIFIED |
| Claude Code Web → GitHub書き込み | 環境依存。handoff-phase1では実績あり |
| Cowork → GitHub書き込み | DENIED（git proxy権限制約） |
| バックアップ経路 | Claude/Coworkで実装・テスト → パッチZIP → ChatGPTがGitHubへ直接反映 |
| main | 未変更 |

## 新捺印表OCR

| 項目 | 状態 |
|---|---|
| `standardizedStampSheet.ts` | GitHub統合済み |
| `lib/ocr/standardizedStampSheet/*` | GitHub統合済み |
| `taskRouting.ts` | `ocr.standardizedStampSheet`追加済み。Anthropic既定 |
| 実物検証版layoutRegistry | 採用済み。room_grid/time_grid/qr_code_area calibrated:true、remarks_area:false |
| Ground Truth | `ground_truth_shinnain_v1_20260811.json` GitHub保存済み |
| source patch unit tests | Claude作業環境で26ファイルALL PASS確認済み |
| source patch release tests | Claude作業環境でALL PASS確認済み。SENSOR MASTER / ROOM ROSTER回帰0 |
| GitHub直接反映後の再テスト | **未実施**。次作業で実行する |
| false positive | 0（下流正規化ロジック実物検証） |
| 実Anthropic API OCR | 未実施 |
| LB本番接続 | 未実施 |
| Vercel production deploy | 未実施 |

## 運用ルール

- GitHubを共有状態の正本とする。
- mainはユーザー明示GOまで変更しない。
- APIキー・Secret・`.env.local`はGitHubへ保存しない。
- Coworkでpushできない場合は同じpushを繰り返さず、パッチ/bundleをChatGPTまたは書き込み権限のある環境へ渡す。
- GitHubへ直接反映した後は、反映後のHEADで必ずunit/releaseを再実行してから次Gateへ進む。
