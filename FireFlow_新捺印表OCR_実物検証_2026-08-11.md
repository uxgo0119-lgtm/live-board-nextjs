# FireFlow 新捺印表OCR 実物検証フェーズ 報告書

作成日: 2026-08-11
対象: 新捺印表 Ver1 / コスモ城東野江ロイヤルフォルム / 1600×2269px

## 結論

P0正規化パイプラインを実物サンプル由来のGround Truthで検証し、**false positive confirmation = 0** を確認した。

ただし、この検証は実Anthropic APIによるVision抽出そのものではなく、実画像を目視確認して作成したraw中間値を実コードへ入力した下流ロジック検証である。したがって1003・405号室のP→A誤読のようなAI Vision抽出精度は未検証であり、次Gateとして実API検証が必要。

## 実測レイアウト

| ゾーン | calibrated | xMinRatio | yMinRatio | xMaxRatio | yMaxRatio |
|---|---|---:|---:|---:|---:|
| room_grid | true | 0.0263 | 0.1441 | 0.9856 | 0.5667 |
| time_grid | true | 0.0256 | 0.6430 | 0.9862 | 0.8563 |
| qr_code_area | true | 0.8163 | 0.0190 | 0.9519 | 0.1168 |
| remarks_area | false | - | - | - | - |

remarks_areaは左右2つの非連続列であり、現行の1ゾーン=1矩形型では正確に表現できないため意図的にcalibrated:falseのままとした。実測値はlayoutRegistry.tsのmeasurementNotesに保持する。

## 重点回帰ケース

- 1003: 正しくP。正しいraw値が渡された場合の正規化は正常。
- 405: 正しくP。正しいraw値が渡された場合の正規化は正常。
- 802: A+P二重チェック → needs_review / MULTIPLE_SYMBOL_CHECKED。
- 1005: P+キャンセル二重チェック → needs_review。
- 805: P+キャンセル二重チェック → needs_review。
- 801: A + 備考「朝一」。開始時刻は十の位空白の「9:30」で、推測して09:30へ補完せずINVALID_FORMAT→needs_review。

## symbol / time 共存

時間指定のある部屋でもsymbol確定後にtime_start/time_endを破棄しないことを確認した。既存Legacy側にあったsymbol/time排他挙動は新経路へ持ち込まない。

## Ground Truth

`ground_truth_shinnain_v1_20260811.json`

- 主グリッド 65室
- 時間指定 7件
- 二重チェック 3件（802 / 1005 / 805）
- 判読困難な異常行は部屋番号を推測せずUNKNOWN扱い

## KPI

- 誤確定（FALSE POSITIVE）: **0**
- 見逃し（FALSE NEGATIVE）: 0（本検証入力範囲）
- 二重チェック: 3/3 SAFE REVIEW
- 十の位空白時刻: 2/2 SAFE REVIEW

## テスト

Claude統合作業環境で以下を実行し全PASSを確認済み。

- `npm run test:unit`: 26ファイルALL PASS
- `npm run test:release`: 全スクリプトALL PASS
- SENSOR MASTER / ROOM ROSTER 回帰テストを含め既存機能の回帰0

## 未完了

1. 実Anthropic APIでのOCR抽出精度検証
2. 同一フォーマット別サンプルでの座標再現性確認
3. LB本番接続
4. Vercel production deploy

判定: **CONDITIONAL GO**。次Gateは実Anthropic API OCR抽出精度検証。
