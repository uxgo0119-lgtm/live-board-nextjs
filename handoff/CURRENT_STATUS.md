# CURRENT_STATUS

（このファイルは現在状態のスナップショットのみ。過去履歴は蓄積しない。詳細な経緯はKnowledge Base・個別報告書を参照）

- **last_updated**: 2026-08-13
- **knowledge_base_version**: Ver1.23
- **active_project**: Live Board（FireFlow）
- **current_phase**: 新捺印表OCR — 実Anthropic API抽出精度検証前
- **current_focus**: GitHub共有handoff連携を運用可能状態に固定し、その後OCR実API検証へ戻る
- **latest_completed**: ChatGPT↔GitHub↔Claude Code Web のhandoff読み書き経路を実地確認。Claude Code側が`handoff/CLAUDE_REPORT.md`へ`GitHub write test: 2026-08-12 PASS`をpushし、ChatGPT側から同一内容を直接確認済み
- **production_state**: NOT_IN_PRODUCTION（新捺印表OCR経路はLive Board本番未接続）
- **release_state**: HANDOFF_OPERATIONAL / OCR_NOT_RELEASED
- **next_gate**: 実Anthropic APIによるOCR抽出精度検証
- **handoff_branch**: `handoff-phase1`
- **main_policy**: ユーザー明示GOまで変更禁止

## ChatGPT ↔ Claude Code handoff状態

| 経路 | 状態 |
|---|---|
| ChatGPT → GitHub読み取り | VERIFIED |
| ChatGPT → handoff-phase1書き込み | VERIFIED |
| Claude Code Web → handoff-phase1書き込み/push | VERIFIED |
| Claude Code Web → main | 禁止（ユーザーGOまで） |
| ユーザーの通常引き継ぎ | 「Claude終わった。見て」で運用可能 |

## 新捺印表OCR（Standardized Stamp Sheet）

| 項目 | 状態 |
|---|---|
| P0実装 | 実装済み成果物あり。ただし現在の正本GitHubへの統合状態は要整理 |
| 実物サンプルによる正規化ロジック検証 | false positive = 0 確認済み |
| 802号室（A+P） | needs_review確認済み |
| 1005号室（P+キャンセル） | needs_review確認済み |
| 805号室（P+キャンセル） | needs_review確認済み |
| symbol/time共存 | 確認済み |
| 実Anthropic API OCR抽出精度検証 | 未完了 |
| LB本番接続 | 未実施 |
| Vercel production deploy | 未実施 |

## ローカル / リモート環境ルール

- GitHubを共有状態の正本とする。
- Claude Code WebはGitHub中心の作業に使用する。
- MacローカルClaude Codeは`.env.local`や実画像などローカル資源が必要な作業に限定する。
- ローカル作業もGitHubの同一作業ブランチを基準にして開始し、成果をGitHubへ戻す。
- APIキー・SecretはGitHubへ保存しない。
