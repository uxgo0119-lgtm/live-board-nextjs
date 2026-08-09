// [2026-08-05新設] lib/ocr-compare/groundTruth.ts の単体テスト。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadGroundTruth, GroundTruthLoadError } from '../../../lib/ocr-compare/groundTruth';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const dir = mkdtempSync(path.join(tmpdir(), 'ocr-compare-gt-test-'));

try {
  // ---- filePath未指定ならnullを返す(正解データ無しモード) ----
  assert(loadGroundTruth(undefined) === null, 'filePath未指定の場合はnullを返す(認識率算出をスキップする合図)');

  // ---- 存在しないファイルはエラー ----
  {
    let threw = false;
    try {
      loadGroundTruth(path.join(dir, 'not-exist.json'));
    } catch (err) {
      threw = err instanceof GroundTruthLoadError;
    }
    assert(threw, '存在しないファイルを指定するとGroundTruthLoadErrorになる');
  }

  // ---- 配列でないJSONはエラー ----
  {
    const p = path.join(dir, 'not-array.json');
    writeFileSync(p, JSON.stringify({ room_number: '101' }), 'utf8');
    let threw = false;
    try {
      loadGroundTruth(p);
    } catch (err) {
      threw = err instanceof GroundTruthLoadError;
    }
    assert(threw, '配列でないJSONはGroundTruthLoadErrorになる');
  }

  // ---- room_numberが無い要素はエラー ----
  {
    const p = path.join(dir, 'missing-room-number.json');
    writeFileSync(p, JSON.stringify([{ symbol: 'A' }]), 'utf8');
    let threw = false;
    try {
      loadGroundTruth(p);
    } catch (err) {
      threw = err instanceof GroundTruthLoadError;
    }
    assert(threw, 'room_numberが無い要素を含むJSONはGroundTruthLoadErrorになる');
  }

  // ---- 正常な形式は正しく読み込まれる ----
  {
    const p = path.join(dir, 'valid.json');
    const data = [{ room_number: '101', symbol: 'A', time: '', time_end: '', note: '', name: '', date: '' }];
    writeFileSync(p, JSON.stringify(data), 'utf8');
    const loaded = loadGroundTruth(p);
    assert(loaded !== null && loaded.length === 1 && loaded[0].room_number === '101', '正常な正解データJSONは正しく読み込まれる');
  }

  console.log('ALL PASS: ocr-compare/groundTruth.test.ts');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
