# 複数物件一括OCR検証ケースの追加手順

このディレクトリに JSON を1つ置くと、その物件が `npm run validate:batch` と
`test/unit/ocr/standardizedStampSheet/batchValidation.test.ts` の対象に自動で加わる。
コードの変更は不要（判定は全てこのJSONのデータ駆動）。

## 1件追加するのに必要なもの（3つだけ）

1. **実OCRの生JSON**（実画像を実APIへ通した結果をそのまま保存したもの）
   - 置き場所: `test/fixtures/standardizedStampSheet/`
   - 形式: `/api/v1/standardized-stamp-sheet/scan` が返す raw と同じ形
     （`rooms[].raw_checkboxes` と `time_designation_rows[]`）
   - 一度保存すれば以後は実APIを呼ばないので、追加の課金は発生しない
2. **MASTERの部屋一覧**（Excel由来。配列 `["101",...]` でも `{"101":6,...}` でも可）
   - 既存の物件データ（例: `public/test/fixtures/prop13/gt_totals.json`）をそのまま指定できる
3. **Ground Truth**（紙面に何が書いてあるかを人が目視で確定したもの）
   - 実装の出力をコピーして作らない。実装の出力に合わせて後から書き換えない
   - 全室そろっていなくてもよい。分かる部屋だけ書けば、その部屋だけ厳密に判定される
     （Ground Truthの無い部屋も「保存・復元・描画で値が変わっていないか」は自動で見る）

## ケースJSONの形

```jsonc
{
  "caseId": "prop14_20260901",              // ファイル名と揃える
  "propertyName": "○○マンション",
  "rawScanPath": "test/fixtures/standardizedStampSheet/real_scan_prop14_20260901.json",
  "masterRoomsPath": "public/test/fixtures/prop14/master_rooms.json",
  "note": "いつ・どの画像から取った生JSONかを書く",
  "expectedSource": "Ground Truthを誰がいつどう作ったかを書く（実装出力から作っていないことの記録）",
  "expected": {
    "masterRoomCount": 66,                  // MASTER（Excel由来）の室数
    "ocrRoomCount": 65,                     // 捺印表に印字されている室数
    "needsReviewRooms": ["802"],            // 二重チェック等で確定できない部屋
    "skippedRoomCount": 0,                  // 読み飛ばして良い部屋数（通常0）
    "unassignedTimeDesignationRowCount": 1, // 部屋番号を特定できない時間指定行の数
    "roomsNotInStamp": ["1102"],            // MASTERにはあるが捺印表に無い部屋
    "rooms": {
      "801": { "symbol": "A", "time_start": "09:30", "note": "朝一" },
      "802": { "symbol": "", "needs_review": true }
    }
  }
}
```

`rooms` の各項目は省略可。省略した項目は「値が無いこと」を期待する
（例: `time_start` を書かなければ、時刻が付いていたら誤確定として検出される）。

## 実行

```
npm run validate:batch     # 全物件を一括検証し、コンソール＋JSON＋CSVで一覧化
npm run test:unit          # 回帰として固定（新しい失敗が増えたら落ちる）
```

失敗は `OCR_FAIL` / `NORMALIZE_FAIL` / `PERSIST_FAIL` / `RENDER_FAIL` に分類され、
Expected / OCR Raw / Canonical / Restored / Render が横並びで出るので、
「最初に値が変わった段階」がそのまま読み取れる。

## やってはいけないこと

- 架空の物件データを作って「複数物件で検証済み」とすること
- テストを通すために Ground Truth を書き換えること
- 特定物件・特定部屋番号を検証コード側に書くこと（判定は必ずこのJSONで表現する）
