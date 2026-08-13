# FireFlow Knowledge Base（共通知識ベース）Ver1.24

作成日: 2026-08-13

## Ver1.24 更新理由

新捺印表OCR（Standardized Stamp Sheet）のP0実装＋2026-08-11実物検証差分＋Ground Truthを、GitHub正本の作業ブランチ`fireflow-ver1-completion`へ統合したため状態を更新する。

## 今回確認済みの事実

- `lib/ai/capabilities/ocr/documentTypes/standardizedStampSheet.ts`をGitHubへ統合済み。
- `lib/ocr/standardizedStampSheet/*`のP0実装一式をGitHubへ統合済み。
- `lib/ai/config/taskRouting.ts`へ`ocr.standardizedStampSheet`を追加済み。既定providerはAnthropic。
- 実物検証版`layoutRegistry.ts`を採用。room_grid / time_grid / qr_code_areaはcalibrated:true、remarks_areaは非連続2列構造のため意図的にcalibrated:false。
- Ground Truth `ground_truth_shinnain_v1_20260811.json`をGitHubへ保存済み。
- 実物検証報告書と検証スクリプトをGitHubへ保存済み。
- Claude作業環境で`npm run test:unit`は26ファイルALL PASS、`npm run test:release`はALL PASS。SENSOR MASTER / ROOM ROSTER / Legacy関連の回帰0を確認済み。
- 実物サンプル由来の下流正規化ロジック検証でfalse positive confirmation = 0。
- mainは未変更。
- Vercel production deployは未実施。
- APIキー、`.env.local`、SecretはGitHubへ保存していない。

## KB-024 状態更新

名称: 新捺印表OCR「誤確定ゼロ優先」Operation Rule

状態: **CONFIRMED / GITHUB_INTEGRATED / NOT_IN_PRODUCTION**

ルール本体は変更しない。

1. A/P/キャンセルは3つの独立booleanで保持する。
2. 2個以上チェックは単一値へ収束させずneeds_review。
3. 誤読辞書は候補生成専用。raw OCRを保持する。
4. 不在・キャンセル等high risk語は近似一致で自動確定しない。
5. fixed-layout座標はlayout_format_id単位で管理する。
6. 不明・曖昧・書式不正は推測せずneeds_reviewへ倒す。

重点回帰ケース:

- 1003: 正解P。Vision抽出そのものは実API未検証。
- 405: 正解P。Vision抽出そのものは実API未検証。
- 802: A+P → needs_review。
- 1005: P+キャンセル → needs_review。
- 805: P+キャンセル → needs_review。
- 801: A＋備考「朝一」。十の位空白の`9:30`を推測で`09:30`へ補完せずneeds_review。

## KB-025 handoff運用状態

ChatGPT↔GitHub↔Claude Codeのhandoff基盤は運用可能。

追加で判明した環境差:

- CoworkセッションはGitHub git proxyの権限制約でpushできない場合がある。
- 同じpushを繰り返さず、パッチ/bundleをChatGPTまたは書き込み権限のある環境へ渡す。
- 今回はChatGPT側のGitHub接続から`fireflow-ver1-completion`へ直接反映し、統合を完了した。

## 次Gate

実Anthropic API OCR抽出精度検証。

目的は「正規化ロジック」ではなく、AI Visionが実画像から正しいraw中間値を返せるかの確認。

合否の最重要条件:

- false positive = 0
- 802 / 1005 / 805を単一symbolへ誤確定しない
- 1003 / 405のPをAへ誤読しない、または不確実ならneeds_reviewへ倒す
- 801の「朝一」を勝手に別語・具体時刻へ確定しない
- 判読不能値を推測補完しない

## Release状態

- `fireflow-ver1-completion`: GITHUB_INTEGRATED
- main: UNCHANGED
- LB本番接続: NOT_DONE
- Vercel production deploy: NOT_DONE
- 次Gate: 実Anthropic API OCR抽出精度検証
