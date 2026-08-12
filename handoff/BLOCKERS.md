# BLOCKERS（現在止まっているものだけ）

| blocker_id | related_task | severity | description | required_action | owner | status |
|---|---|---|---|---|---|---|
| BLOCKER-001 | TASK-2026-08-11-001（実Anthropic API抽出精度検証） | MEDIUM | Web/Cowork等のリモートセッションには`ANTHROPIC_API_KEY`が引き継がれない。Macローカルの`~/FireFlow/live-board-nextjs/.env.local`にはAPIキー設定済みであることをユーザーが確認済み。これはhandoff連携のブロッカーではなく、実API検証をどの実行環境で行うかのブロッカー。 | 実API検証はAPIキーが存在するMacローカル環境で実行するか、リモート実行環境へSecretとして別途安全に設定する。APIキーをGitHubへ保存しない。 | ユーザー / Claude Code | OPEN |
| BLOCKER-002 | handoff/ Phase1基盤全体 | HIGH | GitHub共有handoff層の読み書き可否。 | `uxgo0119-lgtm/live-board-nextjs` の `handoff-phase1` ブランチで、Claude Code側から`handoff/CLAUDE_REPORT.md`への書き込み・pushが成功し、ChatGPT側から同じ内容（`GitHub write test: 2026-08-12 PASS`）を直接読めることを確認済み。 | ChatGPT / Claude Code | RESOLVED |

## status の定義

- `OPEN` — 未解消
- `RESOLVED` — 解消済み（解消後は短期間このファイルに残し、次回整理時に削除可）

## handoff連携の運用状態

- ChatGPT → GitHub 読み取り: **VERIFIED**
- ChatGPT → `handoff-phase1` 書き込み: **VERIFIED**
- Claude Code Web → GitHub `handoff-phase1` 書き込み/push: **VERIFIED**（write test実施済み）
- GitHub `main`: **変更禁止（ユーザー明示GOまで）**
- 通常の引き継ぎ: ユーザーはChatGPTへ「Claude終わった。見て」と伝えるだけでよい。ChatGPTは`handoff/CURRENT_STATUS.md`と`handoff/CLAUDE_REPORT.md`を直接読む。
