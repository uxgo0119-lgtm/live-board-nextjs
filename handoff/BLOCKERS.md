# BLOCKERS（現在止まっているものだけ）

| blocker_id | related_task | severity | description | required_action | owner | status |
|---|---|---|---|---|---|---|
| BLOCKER-001 | TASK-2026-08-11-001（実Anthropic API抽出精度検証） | HIGH | このセッションの実行環境に`ANTHROPIC_API_KEY`（FireFlowアプリ本体が要求する環境変数、`lib/config/env.ts`の`getServerEnv()`が必須とする値）が設定されていない。`.env`/`.env.local`ファイル自体が存在せず、`.env.local.example`のみが存在する状態 | ユーザーが実際のFireFlow用`ANTHROPIC_API_KEY`を、当該セッションの環境変数または`.env.local`として提供する | ユーザー | OPEN |
| BLOCKER-002 | handoff/ Phase1基盤全体 | HIGH | このワーキングコピー（`/tmp/fireflow/live-board-nextjs`）に`.git`ディレクトリが存在せず、Gitリポジトリとして初期化されていない。GitHubのremoteも設定されていない。したがって、この`handoff/`をコミット・pushすること自体が現時点で不可能であり、「ChatGPTがGitHub上でこれを読める」というPhase1の前提が、このセッション内ではまだ成立していない | ユーザーに以下いずれかを確認いただく：(a) 実際のFireFlow Gitリポジトリがどこにあるか（別のセッション/別の作業環境で管理されている場合、そちらへこの`handoff/`一式を反映する必要がある）、(b) このセッション内でGit初期化・remote設定を行ってよいか（その場合も、GitHub main pushにはユーザーの別途の明示的GOが必要） | ユーザー | OPEN |

## status の定義

- `OPEN` — 未解消
- `RESOLVED` — 解消済み（解消後は短期間このファイルに残し、次回整理時に削除可）
