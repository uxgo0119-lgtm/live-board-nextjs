# CURRENT_TASK

（Claude Codeは作業開始時に必ずこのファイルを読むこと。このファイルは常に1タスクのみを保持する。完了・変更時は上書きする）

- **task_id**: TASK-2026-08-11-001
- **title**: 新捺印表OCR 実Anthropic API抽出精度検証
- **requested_by**: ユーザー（uxgo0119@gmail.com）
- **created_at**: 2026-08-11
- **objective**: FireFlow標準 新捺印表Ver1の実物画像を、実際のAnthropic API経由（`standardizedStampSheet` document type限定、Legacy `residentTimeRequestSheet.ts`は不使用）でOCRし、AI Visionが正しい中間表現（`a_checked`/`p_checked`/`cancel_checked`/`time_start`/`time_end`/`remarks`）を生成できるかを検証する。正規化ロジック側の検証（false positive = 0）は別フェーズで完了済み。今回はOCR抽出精度そのものを対象とする。
- **scope**: `lib/ai/capabilities/ocr/documentTypes/standardizedStampSheet.ts`経由のAPI呼び出しと、その結果の`ground_truth_shinnain_v1_20260811.json`との比較のみ。コード変更は想定しない（検証専用タスク）。
- **files_to_check**:
  - `FireFlow_Knowledge_Base_Ver1.22_2026-08-11.md`
  - `FireFlow_新捺印表OCR_実物検証_2026-08-11.md`
  - `ground_truth_shinnain_v1_20260811.json`
  - `lib/ai/capabilities/ocr/documentTypes/standardizedStampSheet.ts`
  - `lib/ocr/standardizedStampSheet/*`
- **must_not_change**:
  - Legacy捺印表経路（`residentTimeRequestSheet.ts`）
  - SENSOR MASTER
  - ROOM ROSTER
  - MASTER/DELTA境界
  - 点検予定表OCR
  - 既存認証・レート制限
  - LB UI（`lb_tool/index.html`）
- **acceptance_criteria**:
  - Anthropic API実呼び出し成功
  - 1003=P、405=P（正しい中間値からの収束ではなく、実APIの生読み取り結果として）
  - 802=A+P検出（needs_review）
  - 1005=P+キャンセル検出（needs_review）
  - 805=P+キャンセル検出（needs_review）
  - 801のA保持、「朝一」が正しく抽出されるか、または安全なcandidate/review
  - false positive = 0
  - 既存テスト全PASS、Legacy/SENSOR MASTER/ROOM ROSTER回帰ゼロ
- **validation**: `npm run test:unit`、`npm run test:release`、実API呼び出し結果とGround Truthの比較（raw抽出精度と正規化後精度を分離して評価）
- **release_permission**: LB本番接続・GitHub main push・Vercel deployは、本タスクの範囲外（ユーザーの別途の明示的GOが必要）
- **status**: **BLOCKED**（`ANTHROPIC_API_KEY`が現在の実行環境に未設定。詳細は`handoff/BLOCKERS.md`のBLOCKER-001を参照）
