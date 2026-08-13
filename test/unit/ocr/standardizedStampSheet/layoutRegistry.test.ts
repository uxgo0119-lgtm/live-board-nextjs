import { getLayoutFormat, isLayoutFullyCalibrated, STANDARDIZED_STAMP_SHEET_V1 } from '../../../../lib/ocr/standardizedStampSheet/layoutRegistry';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

{ const format = getLayoutFormat('standardized_stamp_sheet_v1'); assert(!!format, 'format exists'); assert(format!.layoutFormatId === 'standardized_stamp_sheet_v1', 'id'); }
{ assert(getLayoutFormat('nonexistent_format_v99') === null, 'unknown format null'); }
{ const zoneNames = Object.keys(STANDARDIZED_STAMP_SHEET_V1.zones); assert(zoneNames.length === 4, '4 zones'); }
for (const zoneName of ['room_grid', 'time_grid', 'qr_code_area'] as const) {
  const zone = STANDARDIZED_STAMP_SHEET_V1.zones[zoneName];
  assert(zone.calibrated === true, `${zoneName} calibrated`);
  assert(zone.coordinates !== null, `${zoneName} coords`);
  const c = zone.coordinates!;
  assert(c.xMinRatio >= 0 && c.xMinRatio < c.xMaxRatio && c.xMaxRatio <= 1, `${zoneName} x`);
  assert(c.yMinRatio >= 0 && c.yMinRatio < c.yMaxRatio && c.yMaxRatio <= 1, `${zoneName} y`);
}
{
  const zone = STANDARDIZED_STAMP_SHEET_V1.zones.remarks_area;
  assert(zone.calibrated === false, 'remarks uncalibrated');
  assert(zone.coordinates === null, 'remarks null coords');
  assert(!!zone.measurementNotes && zone.measurementNotes.length > 0, 'remarks notes');
}
assert(isLayoutFullyCalibrated('standardized_stamp_sheet_v1') === false, 'not fully calibrated');
assert(isLayoutFullyCalibrated('nonexistent_format_v99') === false, 'unknown false');
console.log('layoutRegistry.test.ts: ALL PASS');
