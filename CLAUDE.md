# CLAUDE.md

## 最優先：FireFlow 開発 絶対ルール

FireFlow / Live Board / Report Flow に関する作業を開始する前に、

`docs/FireFlow_開発絶対ルール_2026-08-14.md`

を必ず読み、そのルールを全作業に適用すること。

- 調査・修正・テスト・報告のすべてに適用する
- セッションが変わっても毎回必ず読み込む
- このルールと矛盾する判断はしない

## 承認要求の方針

`.claude/settings.local.json` の permissions を尊重し、許可済みの安全な通常操作
（読み取り・検索・リポジトリ内編集・テスト・typecheck・build・dev server・localhost確認）で
ユーザーへ確認を求めない。確認を残すのは commit / push / deploy / 破壊的操作 /
依存パッケージ変更 / 秘密情報（.env・APIキー）関連 / 本番データ変更などの重要操作のみ。
詳細は絶対ルールの「14. Claude Codeの承認要求は重要操作に限定する」を正本とする。
