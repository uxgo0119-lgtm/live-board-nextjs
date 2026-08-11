# FireFlow Knowledge Base（共通知識ベース）Ver1.23

作成日: 2026-08-11（Ver1.22からの更新。ChatGPT↔Claude Code間のhandoff基盤〔Phase1〕新設を受けた更新）
対象範囲: これまで実データ分析を行った14物件＋LB部屋カード表示ルール＋ROOM ROSTER構築のOperation Rule（Ver1.19）＋新捺印表OCR誤確定防止Operation Rule（KB-024、Ver1.20〜1.22）＋本Ver1.23で新設するChatGPT↔Claude Code handoff運用ルール（KB-025）
性質: Ver1.23本体は、新捺印表OCRに関するKB-001〜024には変更を加えず、`live-board-nextjs/handoff/`ディレクトリの新設（Phase1、GitHub共有状態管理層）に伴い、新規Pattern KB-025を追加したものである。

**文書の簡略化について（Ver1.23）**：本ファイルはVer1.23（新規ログ）とVer1.22（直近1世代の履歴）のみを更新ログとして保持する。Ver1.0〜Ver1.21の逐次更新ログ本文は、プロジェクト内に保存済みの`FireFlow_Knowledge_Base_Ver1.22_2026-08-11.md`に全文保持されているため、本ファイルでは重複掲載を省略する。

## Ver1.23 更新ログ（必須項目）

■ 更新理由：ユーザーより、ChatGPT・ユーザー・Claude Code間の手動コピペ運用負担を軽減するため、GitHubリポジトリを共有状態管理層として使う「handoff Phase1」の実装依頼があった。`live-board-nextjs`直下に`handoff/`ディレクトリ（README/CURRENT_STATUS/CURRENT_TASK/CLAUDE_REPORT/DECISIONS/BLOCKERS の6ファイル）を新規作成し、現在のFireFlow状態（KB Ver1.22・直近の実物検証報告に基づく）を初期登録した。

■ 更新内容：**新規Pattern KB-025として、handoff運用の「再利用可能な運用原則」のみを登録する。** ユーザー指示どおり、ファイルを作成しただけの段階を「運用実績あり」「連携完成」とは記載しない。

登録する運用原則（この5点のみ。個別のCURRENT_STATUS等の中身はKBの対象外、`handoff/`側で管理）：

1. GitHubリポジトリを、ChatGPTとClaude Codeが共有するプロジェクト状態管理層として使用する（API同士の直接自動連携ではなく、人間が「見て」と伝えるだけで済む状態を目指す）。
2. Claude Codeは作業開始時に、必ず`handoff/CURRENT_STATUS.md`・`handoff/CURRENT_TASK.md`・`handoff/DECISIONS.md`・`handoff/BLOCKERS.md`を確認する（Knowledge Baseの確認に加えて）。
3. Claude Codeは作業終了時に、必ず`handoff/CLAUDE_REPORT.md`・`handoff/CURRENT_STATUS.md`を更新する（`CURRENT_TASK.md`のstatus・`BLOCKERS.md`もあわせて更新する）。
4. `handoff/`は「今この瞬間の状態」のみを保持し、上書き更新を基本とする。長期的・再利用可能な知識はKnowledge Base側に置き、`handoff/`を無限に肥大化させない。
5. GitHub mainへのpushは、`handoff/`関連の変更であっても、ユーザーの明示的GOなしでは行わない（既存のリリースガバナンス、DEC-007と同一）。

**状態：Phase1 handoff基盤実装済み／実運用未検証。**

理由：`handoff/`の6ファイルはローカルに作成・初期登録し、テスト（`npm run test:unit`全26ファイルPASS、`npm run test:release`38/38 PASS、`npx tsc`新規エラー0件）を実施したが、(a) ChatGPTが実際にこの`handoff/`をGitHub経由で読み、Claude Codeへの次タスク指示に使う、という往復運用の実績はまだ無い。(b) さらに重要な制約として、**このセッションの作業ディレクトリ（`/tmp/fireflow/live-board-nextjs`）にはGitリポジトリ自体が存在しない**（`.git`無し、remote無し）ことが判明した。したがって`handoff/`一式はローカルファイルとして存在するのみで、GitHubへのコミット・push自体がまだ行われておらず、「ChatGPTがGitHub上でこれを読める」というPhase1の前提そのものが、このセッション内では未成立である。ユーザーが実際に運用しているFireFlowのGitリポジトリへこの`handoff/`一式を反映する作業（別セッションでの適用、またはこのセッションへのGit接続）が別途必要。

■ 追加Pattern：あり（KB-025、ChatGPT↔Claude Code handoff運用ルール、新設）

■ 撤回Pattern：なし

■ 件数更新：なし　■ 発生率更新：なし　■ 状態変更：なし（KB-001〜024、内容・状態ともに変更なし）

■ OFFICIAL_RULE追加有無：なし（KB-025もOperation Ruleとして登録。実運用未検証のためOFFICIAL_RULEへの昇格は時期尚早）

■ Operation Rule変更有無：あり（KB-025新設のみ。KB-001〜024は無変更）

■ 特記事項：KB-025は「GitHubをhandoff層として使う」という運用原則の登録であり、`handoff/`配下の個別ファイルの内容（CURRENT_STATUS等の中身）はKBの管理対象外。これらは`handoff/README.md`が定める役割分担のとおり、KBより高頻度に上書き更新される前提であり、KBに転記・同期する対象ではない。

---

## Ver1.22 更新ログ（履歴）

■ 更新理由：KB-024に対応する実装（Ver1.21で完了）について、実物サンプル1点を用いた検証フェーズを実施した。座標の実測（room_grid／time_grid／qr_code_areaの3ゾーン）、および実装済みの正規化コードへ目視確認したGround Truthを通した検証を行い、誤確定（false positive）＝0を達成した。

■ 追加Pattern：なし　■ 状態変更：あり（KB-024、実物サンプル検証完了を反映）

■ 特記事項：座標実測はサンプル1件のみに基づく。remarks_areaは非連続2列構造のため意図的にcalibrated:false据え置き。AI OCRプロバイダの実地精度検証は未実施のまま（Ver1.23時点でも未解消。`ANTHROPIC_API_KEY`未設定のためBLOCKED、詳細は`handoff/BLOCKERS.md`参照）。

---

**Ver1.0〜Ver1.21の更新ログ本文は`FireFlow_Knowledge_Base_Ver1.22_2026-08-11.md`（プロジェクト内に保存済み）を参照してください。** 以下、KB-001〜025の各Pattern定義・サマリー表・OFFICIAL_RULE登録状況・Knowledge Base運用ルール・停止条件は、Ver1.23時点の内容をそのまま最新版として保持しています。

---

## KB-001〜KB-024

Ver1.23でKB-001〜024の内容・状態・発生件数・発生率に変更はありません。各Patternの詳細定義は`FireFlow_Knowledge_Base_Ver1.22_2026-08-11.md`（KB-024の全文含む）を参照してください（本ファイルでの重複掲載は省略します。KB-025のみ新規のため以下に全文を掲載します）。

---

## KB-025（Ver1.23新設）

■ 分類：Operation Rule

■ 名称：ChatGPT ↔ Claude Code handoff運用ルール（GitHub共有状態管理層、Phase1）

■ 内容：ChatGPT・ユーザー・Claude Code間の手動コピペ負担を減らすため、以下5点を運用原則とする。

1. GitHubリポジトリを、ChatGPTとClaude Codeが共有するプロジェクト状態管理層として使用する。
2. Claude Codeは作業開始時に、Knowledge Baseに加えて`handoff/CURRENT_STATUS.md`・`handoff/CURRENT_TASK.md`・`handoff/DECISIONS.md`・`handoff/BLOCKERS.md`を確認する。
3. Claude Codeは作業終了時に、`handoff/CLAUDE_REPORT.md`・`handoff/CURRENT_STATUS.md`・`handoff/CURRENT_TASK.md`のstatus・`handoff/BLOCKERS.md`を更新する。
4. `handoff/`は「今この瞬間の状態」のみを保持し（上書き更新が基本）、長期的知識はKnowledge Base側に置く。
5. GitHub mainへのpushは、`handoff/`関連の変更であってもユーザーの明示的GOなしでは行わない（DEC-007と同一原則）。

■ KB-018・KB-024との関係：内容面では独立（OCR/正規化ロジックとは無関係）。運用ガバナンスの原則という点でDEC-007（GitHub main pushはユーザーGO後）を前提としている。

■ 状態：**CONFIRMED（運用原則として確定。Phase1 handoff基盤〔`handoff/`6ファイル〕はローカルに実装済み・テスト済み。ただし実運用〔ChatGPTとの往復での実績〕は未検証。加えて、作業対象のワーキングコピーにGitリポジトリが存在せず、GitHubへの反映自体がこのセッション内では未完了であることが判明している）。**

■ 発生物件数：該当なし（運用インフラのPattern）

■ 推奨対応：P1（OCR誤確定防止〔KB-024〕ほど緊急性は高くないが、日常運用の負担軽減効果は大きい）

■ 過去Knowledge Baseとの関係：Ver1.23で新規登録。

---

## サマリー表（KB-001〜025、Ver1.23時点）

| Pattern ID | 分類 | 状態 | 発生率 | 推奨対応 |
|---|---|---|---|---|
| KB-001〜KB-023 | （各種、Ver1.22から変更なし） | （Ver1.22から変更なし） | （Ver1.22から変更なし） | （Ver1.22から変更なし） |
| KB-024 | Operation Rule | CONFIRMED（実装・単体テスト・実物サンプル検証完了。実プロバイダ精度検証・複数サンプル再現性確認・本番投入は未実施） | 対象外 | P0 |
| KB-025 | Operation Rule | CONFIRMED（運用原則確定。handoff基盤実装済み・実運用未検証。Git未接続のためGitHub反映も未完了） | 対象外 | P1 |

詳細な個別行（KB-001〜023）は`FireFlow_Knowledge_Base_Ver1.22_2026-08-11.md`のサマリー表を参照してください。

---

## OFFICIAL_RULE登録状況

Ver1.22から変更なし（4件：KB-004・KB-012・KB-018・KB-021）。KB-024・KB-025ともにOFFICIAL_RULEへは未昇格（Operation Ruleのまま）。

---

## Knowledge Base運用ルール（Ver1.1制定、継続適用）

Ver1.22の運用ルールに加え、Ver1.23で以下を追加する：

- **「基盤を作成した」ことと「運用実績がある」ことを区別して記載する。** KB-025のように、ファイル・仕組みそのものは実装済みでも、実際の反復運用（ChatGPTとの往復等）の実績が無い場合は、状態欄に必ず「実運用未検証」等と明記し、あたかも運用が確立しているかのような表現にしない。これはKB-024で確立した「各段階の完了状況を状態欄で正確に区別する」原則（Ver1.21で追加）を、実装以外の運用インフラにも適用したものである。

---

## 追加分析停止条件との関係（Ver1.23時点、Ver1.17から変更なし）

**追加分析フェーズの停止条件を満たした状態を維持している（3/3）。**

---

以上がFireFlow Knowledge Base Ver1.23です。**追加分析フェーズの停止条件を満たしています（3/3）。** 次回参照者は、本Ver1.23（特にKB-025）・`FireFlow_Knowledge_Base_Ver1.22_2026-08-11.md`（KB-001〜024の全文）・`live-board-nextjs/handoff/`配下の各ファイル（現在状態のリアルタイムなスナップショット）を参照してください。次の焦点は、(1) BLOCKER-002（Git未接続）の解消、(2) BLOCKER-001（`ANTHROPIC_API_KEY`未設定）の解消と実プロバイダOCR抽出精度検証の再開、(3) KB-025の実運用実績の蓄積、です。
