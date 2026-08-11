# FireFlow handoff/ ディレクトリ

作成日: 2026-08-11
目的: ChatGPT ↔ ユーザー ↔ Claude Codeの手動コピペ負担を減らすための、GitHub上の共有状態管理層（Phase1）。

## 重要な前提（最初に必ず読むこと）

**この`handoff/`は、Claude Codeの作業ログの完全な代替ではありません。** 「今この瞬間の状態」だけを短く保つための場所です。長い経緯・議論の全文はKnowledge Base側（`FireFlow_Knowledge_Base_*.md`）または個別の完了報告書に置きます。

**この`handoff/`が実際にGitHub上で機能するためには、このディレクトリがコミットされ、実際のFireFlowリポジトリのGitHub remoteへpushされている必要があります。** 現時点でこの前提が満たされているかどうかは、作業を行ったセッション環境によって異なります。必ず`CURRENT_STATUS.md`の`release_state`を確認し、`PUSHED_TO_MAIN`未満の場合は「ChatGPTがGitHub上でこれを読める状態にはまだなっていない」と判断してください。

## ファイル構成と役割

| ファイル | 役割 | 更新頻度 |
|---|---|---|
| `CURRENT_STATUS.md` | FireFlowの現在地点（状態のスナップショットのみ、履歴は蓄積しない） | 作業終了時に上書き更新 |
| `CURRENT_TASK.md` | Claude Codeが次に実行すべきタスク1件 | タスク開始/完了/変更時 |
| `CLAUDE_REPORT.md` | 直近のClaude Code作業結果1件（最新のみ、過去分は追記しない） | 作業終了時に上書き更新 |
| `DECISIONS.md` | 現在有効な、覆してはいけない重要判断の一覧 | 新しい確定判断が出た時のみ追記 |
| `BLOCKERS.md` | 現在止まっているものだけ | ブロック発生/解消時 |

## Knowledge Baseとの役割分担

- **Knowledge Base**（`FireFlow_Knowledge_Base_Ver*.md`）：長期的・再利用可能・正式なFireFlow知識。Pattern/Operation Ruleとして蓄積する。
- **`handoff/CURRENT_STATUS.md`**：今この瞬間どこまで進んでいるか（スナップショット、上書き）。
- **`handoff/CURRENT_TASK.md`**：Claude Codeが今何をするか（1タスクのみ）。
- **`handoff/CLAUDE_REPORT.md`**：直近のClaude作業結果（1件のみ、上書き）。
- **`handoff/DECISIONS.md`**：現在有効な重要判断の早見表（KBの代替ではない。KBの中でも特に重要な確定事項の抜粋＋現在の有効性ステータス）。
- **`handoff/BLOCKERS.md`**：現在止まっているものだけ（解消済みは短期間RESOLVEDとして残した後に整理）。

Knowledge Baseを毎回巨大化させないため、一時的な進捗は`handoff/`側を優先して更新してください。

## Claude Code運用ルール

### 作業開始時に必ず確認する順序

1. 最新Knowledge Base（`FireFlow_Knowledge_Base_Ver*.md`、最新バージョンを確認）
2. `handoff/CURRENT_STATUS.md`
3. `handoff/CURRENT_TASK.md`
4. `handoff/DECISIONS.md`
5. `handoff/BLOCKERS.md`

### 作業終了時に必ず更新する順序

1. `handoff/CLAUDE_REPORT.md`（今回の作業結果で上書き）
2. `handoff/CURRENT_STATUS.md`（現在状態を反映）
3. `handoff/CURRENT_TASK.md`のstatus更新
4. `handoff/BLOCKERS.md`（新規ブロック追加、または解消済みへ変更）
5. 必要な場合のみKnowledge Base更新（新しい再利用可能なルールが確定した場合のみ。単発の作業ログはKBへ書かない）

## release_state の語彙（統一・固定）

このディレクトリ内のすべてのファイルで、以下の6状態のいずれかのみを使用してください（表記ゆれ禁止）。

- `LOCAL_MODIFIED` — ローカルで変更済み、テスト未実施
- `TESTED` — ローカルでテスト済み（`npm run test:unit`・`npm run test:release`等）
- `READY_FOR_USER_GO` — テスト済みで、ユーザーの明示的GO待ち
- `PUSHED_TO_MAIN` — GitHub mainへpush済み（ユーザーGO後のみ）
- `DEPLOYED` — Vercel等へデプロイ済み
- `PRODUCTION_VERIFIED` — 本番環境で実際に確認済み

**GitHub mainへのpushは、ユーザーの明示的なGOなしでは行いません。** `PUSHED_TO_MAIN`以降の状態は、必ずユーザーの明示的な許可を経てからのみ到達します。

## 未確認事項の書き方

「たぶん」「おそらく」等の曖昧語で確定事項のように書かないこと。確認できていない事項は `UNKNOWN` と明記すること。
