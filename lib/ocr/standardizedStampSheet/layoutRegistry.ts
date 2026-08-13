// lib/ocr/standardizedStampSheet/layoutRegistry.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 新捺印表のfixed-layout座標を、帳票フォーマットversion(layout_format_id)単位で管理する
// レジストリ(KB-024ルール5: 特定物件専用のhard-codeにしない)。
//
// 【2026-08-11 実物検証フェーズで更新】実物サンプル1点(コスモ城東野江ロイヤルフォルム、
// 2026-08-11点検日、1600×2269px)を実測し、room_grid / time_grid / qr_code_area の3ゾーンを
// calibrated:true へ更新した。remarks_areaは意図的にcalibrated:falseのまま据え置いている。

import type { StampSheetZoneName, StandardizedStampLayoutFormat } from './types';

const UNCALIBRATED_ZONE_WITH_NOTES = (description: string, measurementNotes: string) => ({
  description,
  calibrated: false as const,
  coordinates: null,
  measurementNotes,
});

export const STANDARDIZED_STAMP_SHEET_V1: StandardizedStampLayoutFormat = {
  layoutFormatId: 'standardized_stamp_sheet_v1',
  effectiveFrom: '2026-08',
  pageSize: 'A4',
  zones: {
    room_grid: {
      description:
        '全戸番号印字済み・A/P/キャンセル固定チェック欄のグリッド領域。4ブロック(部屋番号|A|P|キャンセルの4列×各16〜17行)の外接矩形。',
      calibrated: true,
      coordinates: { xMinRatio: 0.0263, yMinRatio: 0.1441, xMaxRatio: 0.9856, yMaxRatio: 0.5667 },
      measurementNotes:
        '実物サンプル1点(1600x2269px)をOpenCVの水平/垂直投影プロファイルで実測。ヘッダー行はy比0.1441-0.1811。' +
        'データ行はブロック2-4が16行(y比最大0.5425)、ブロック1のみ17行(y比最大0.5667、こちらを外接矩形の下端に採用)。' +
        '4ブロックの列区切りx比: ブロック1[0.0263,0.1031,0.1563,0.2075,0.2588] / ブロック2[0.2731,0.3475,0.4006,0.4513,0.4988] / ' +
        'ブロック3[0.5144,0.5888,0.6419,0.6925,0.7419] / ブロック4[0.7556,0.8269,0.8794,0.9313,0.9856](各区切りは部屋番号|A|P|キャンセル|次列境界)。' +
        'サンプル1点のみでの実測のため、他物件での再現性は未確認。',
    },
    time_grid: {
      description:
        '時間指定エリア。部屋番号4桁+開始HH:MM+終了HH:MMを1マス1文字で記入するグリッド領域。左右2サブテーブル(各6行)の外接矩形。',
      calibrated: true,
      coordinates: { xMinRatio: 0.0256, yMinRatio: 0.643, xMaxRatio: 0.9862, yMaxRatio: 0.8563 },
      measurementNotes:
        '実物サンプル1点をOpenCVの投影プロファイルで実測。ヘッダー行y比0.6430-0.6712、データ6行がy比0.8563まで(行ピッチ約70px)。' +
        '左サブテーブルの列区切りx比[0.0256,0.1475,0.27,0.3887,0.4956]、右サブテーブル[0.5144,0.6362,0.7588,0.8794,0.9862]' +
        '(各: 部屋番号|開始|終了|備考|次列境界)。サンプル1点のみでの実測のため、他物件での再現性は未確認。',
    },
    remarks_area: UNCALIBRATED_ZONE_WITH_NOTES(
      '自由記述の備考欄。実際にはtime_gridテーブル内、左右サブテーブルそれぞれの4列目(備考列)として2箇所・非連続に存在する。',
      '現行のStampSheetZoneDefinition型は「1ゾーン=1矩形」を前提としており、非連続な2列を1つの矩形へ強制的に集約すると不正確になるためcalibrated:falseのまま据え置く。左備考列x比[0.3887,0.4956]、右備考列x比[0.8794,0.9862]、y比[0.6430,0.8563]。'
    ),
    qr_code_area: {
      description: 'QRコード領域。',
      calibrated: true,
      coordinates: { xMinRatio: 0.8163, yMinRatio: 0.019, xMaxRatio: 0.9519, yMaxRatio: 0.1168 },
      measurementNotes:
        'OpenCV QRCodeDetector().detect()で4隅のバウンディングボックスを実測。ペイロードは未確認。位置のみを実測値として採用。',
    },
  },
};

const LAYOUT_REGISTRY: Record<string, StandardizedStampLayoutFormat> = {
  [STANDARDIZED_STAMP_SHEET_V1.layoutFormatId]: STANDARDIZED_STAMP_SHEET_V1,
};

export function getLayoutFormat(layoutFormatId: string): StandardizedStampLayoutFormat | null {
  return LAYOUT_REGISTRY[layoutFormatId] ?? null;
}

export function isLayoutFullyCalibrated(layoutFormatId: string): boolean {
  const format = getLayoutFormat(layoutFormatId);
  if (!format) return false;
  const zoneNames = Object.keys(format.zones) as StampSheetZoneName[];
  return zoneNames.every((zoneName) => format.zones[zoneName].calibrated);
}
