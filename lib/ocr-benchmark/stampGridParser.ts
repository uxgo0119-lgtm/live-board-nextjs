// lib/ocr-benchmark/stampGridParser.ts
//
// [2026-07-28新設] 捺印表(点検希望時間連絡票)のレイアウトをヒューリスティックに解析する
// グリッドパーサー。lib/ocr-benchmark/visionOcr.ts / documentAiOcr.ts が返す共通中間形式
// (単語+正規化座標の配列、lib/ocr-benchmark/types.ts参照)を受け取り、
// lib/ocr-benchmark/types.ts の StampSheetEntry[] (LB側 index.html の
// applyStampBulkResult/applyStampSingleOcrResult/#stampReviewSave が期待する既存JSON形式と
// 完全一致)を組み立てる。
//
// 【実際の帳票レイアウト(demo_real_inkanhyou.js・実画像から把握したもの)】
// 捺印表は「部屋番号が印字された見出し行の直後に、入居者が手書きした『25(土)午前』のような
// 日付+午前/午後の記入がある」という縦方向の反復構造になっている(まれに、記入欄の下にもう
// 1行、『13:00頃』『9:30頃』のような補足メモが手書きで追加されていることがある)。
// 5〜7部屋ずつが1つの列にまとまり、複数列が横に並ぶ。列によっては、最後の部屋の記入の後に
// 次の部屋番号が続かず、そのまま列が終わる(＝「列の端」のケース)。また、記入が完全に
// 空白の部屋(この帳票では1516号室)もあり、その場合は既存のBULK_PROMPTの方針
// (「部屋番号が読み取れない項目は含めないでください」を、パーサー側でも踏襲し
// 「記入が空の部屋は結果に含めない」)に合わせて結果から除外する。
//
// 【解析方針】
// 1. 単語のx座標(中心)でクラスタリングして「列」を検出する(「部屋番号らしい」単語を
//    列の目印として先にクラスタリングし、それ以外の単語は最も近い目印列へ割り当てる。
//    詳細はclusterIntoColumns()のコメント参照)。
// 2. 各列内で単語をy座標(中心)でギャップクラスタリングして「行」にまとめる
//    (同じ行の単語はx順に連結してテキスト化する)。
// 3. 各行のテキストが「部屋番号らしい」(2〜4桁の数字のみ)かどうかを正規表現で判定する。
//    部屋番号行が来たら新しい部屋のブロックを開始し、次の部屋番号行が来るまで(または列の
//    終端まで)の行を、その部屋の記入内容として集める。
// 4. 集めたテキストから、日付原文(例: '25(土)')・symbol('A'/'P'/'キャンセル')・
//    それ以外の残りの文字列(note)を正規表現で分離する。
// 5. 部屋番号行の直後に記入が1行も無かった部屋(空白)は結果に含めない。

import type { OcrWord, StampSheetEntry, StampSymbol } from './types';

// --- 定数(実データのレイアウトを見て決めた値。座標は0〜1正規化) ---

// 部屋番号らしい単語(列の目印)同士をまとめる際のx方向のギャップしきい値。
// 部屋番号が1つも検出できなかった場合のフォールバック(全単語のx座標でそのまま
// ギャップクラスタリングする)にも使う。実際の帳票は5列がほぼ均等な幅で並ぶため、
// 列間の間隔より十分小さい値にしてある。
const COLUMN_X_GAP = 0.06;

// 同じ行とみなすy方向のギャップしきい値。手書き1行の高さのばらつきより大きく、
// 「日付+午前午後」の行と、その下の補足メモ行(例: '13:00頃')を別行として区別できる
// 程度の値にしてある。
const LINE_Y_GAP = 0.012;

// 部屋番号行の直後のブロックに、明らかに帳票の説明文(「お世話になります…」等の
// 定型文)が紛れ込んだ場合に無視するための簡易ノイズ判定。実画像では、この種の説明文が
// 列のすぐ右側の空きスペースに大きな1ブロックとして印字されており、数字を含まず長い、
// という特徴があるため、それで判別する。
const NOISE_MIN_LENGTH = 25;

const ROOM_NUMBER_RE = /^\d{2,4}$/;
const DATE_RE = /(?:\d{1,2}\s*\/\s*)?\d{1,2}\s*[(（]\s*[月火水木金土日]\s*[)）]/;
const CANCEL_RE = /キャンセル/;
const AM_RE = /午前/;
const PM_RE = /午後/;

function isNoiseLine(text: string): boolean {
  return text.length > NOISE_MIN_LENGTH && !/\d/.test(text);
}

interface WordWithCenter {
  text: string;
  centerX: number;
  centerY: number;
}

function withCenters(words: OcrWord[]): WordWithCenter[] {
  return words
    .filter((w) => w.text && w.text.trim().length > 0)
    .map((w) => ({
      text: w.text.trim(),
      centerX: w.boundingBox.x + w.boundingBox.width / 2,
      centerY: w.boundingBox.y + w.boundingBox.height / 2,
    }));
}

// x座標の1次元ギャップクラスタリング(値の配列を受け取り、グループごとの平均値を返す)。
function clusterAnchorXs(xs: number[], gap: number): number[] {
  const sorted = [...xs].sort((a, b) => a - b);
  const groups: number[][] = [];
  let current: number[] = [];
  let lastX: number | null = null;
  for (const x of sorted) {
    if (lastX !== null && x - lastX > gap) {
      groups.push(current);
      current = [];
    }
    current.push(x);
    lastX = x;
  }
  if (current.length) groups.push(current);
  return groups.map((g) => g.reduce((s, x) => s + x, 0) / g.length);
}

// 単語を列(縦の並び)に分ける。
//
// 【設計上の注意】当初、全単語のx座標(中心)をそのまま1次元ギャップクラスタリングして
// いたが、これだと「同じ列内の手書き文字が、部屋番号よりも右にずれて書かれている」
// ケース(例: 日付の右側に書かれた『午後』が、部屋番号の中心よりCOLUMN_X_GAP以上
// 右に離れてしまう)で、誤って隣の列だと判定されてしまう問題があった(実際にこの
// プロジェクトのオフラインテストで発生し、原因を特定した上で以下の方式に変更した)。
// そこで、まず「部屋番号らしい単語」(印字のため列ごとにx位置が安定している)だけを
// 目印(アンカー)としてクラスタリングして列のx位置を決め、それ以外の手書き単語は
// 単純に「一番近いアンカー列」へ割り当てる、という2段階の方式にしている。
function clusterIntoColumns(words: OcrWord[]): WordWithCenter[][] {
  const withC = withCenters(words);
  if (withC.length === 0) return [];

  const roomAnchorXs = withC.filter((w) => ROOM_NUMBER_RE.test(w.text)).map((w) => w.centerX);
  const anchors =
    roomAnchorXs.length > 0
      ? clusterAnchorXs(roomAnchorXs, COLUMN_X_GAP)
      : // 部屋番号が1つも検出できなかった場合のフォールバック: 全単語のx座標でそのまま
        // ギャップクラスタリングする。
        clusterAnchorXs(withC.map((w) => w.centerX), COLUMN_X_GAP);

  // clusterAnchorXsはグループを左(小さいx)から右の順に返すため、columns[]のインデックスは
  // そのまま列の左から右への順序になる。
  const columns: WordWithCenter[][] = anchors.map(() => []);
  for (const w of withC) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const dist = Math.abs(w.centerX - anchors[i]);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    columns[bestIdx].push(w);
  }
  return columns;
}

interface LineResult {
  text: string;
}

// 列内の単語を、y座標(中心)の1次元ギャップクラスタリングで行にまとめ、
// 各行内はx順に連結してテキスト化する(上から下の順で返す)。
function clusterIntoLines(columnWords: WordWithCenter[]): LineResult[] {
  const sorted = [...columnWords].sort((a, b) => a.centerY - b.centerY);
  const lineGroups: WordWithCenter[][] = [];
  let current: WordWithCenter[] = [];
  let lastY: number | null = null;
  for (const w of sorted) {
    if (lastY !== null && w.centerY - lastY > LINE_Y_GAP) {
      lineGroups.push(current);
      current = [];
    }
    current.push(w);
    lastY = w.centerY;
  }
  if (current.length) lineGroups.push(current);

  return lineGroups.map((group) => {
    const byX = [...group].sort((a, b) => a.centerX - b.centerX);
    return { text: byX.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim() };
  });
}

interface ParsedScheduleText {
  symbol: StampSymbol;
  date: string;
  note: string;
}

// 部屋番号行の直後〜次の部屋番号行の手前までに集めた行のテキストから、日付原文・symbol・
// それ以外の残り(note)を分離する。全て空(手がかりが何も無い)ならnullを返す
// (呼び出し側はその部屋を結果に含めない)。
function parseScheduleBlockText(rawLines: string[]): ParsedScheduleText | null {
  const joined = rawLines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!joined) return null;

  let remainder = joined;
  let date = '';
  const dateMatch = DATE_RE.exec(joined);
  if (dateMatch) {
    date = dateMatch[0].replace(/\s+/g, '');
    remainder = remainder.replace(dateMatch[0], ' ');
  }

  let symbol: StampSymbol = '';
  if (CANCEL_RE.test(remainder)) {
    symbol = 'キャンセル';
    remainder = remainder.replace(CANCEL_RE, ' ');
  } else if (AM_RE.test(remainder)) {
    symbol = 'A';
    remainder = remainder.replace(AM_RE, ' ');
  } else if (PM_RE.test(remainder)) {
    symbol = 'P';
    remainder = remainder.replace(PM_RE, ' ');
  }

  const note = remainder.replace(/\s+/g, ' ').trim();

  if (!date && !symbol && !note) return null;
  return { symbol, date, note };
}

// メインエントリポイント: 共通中間形式(単語+正規化座標)を、既存JSON形式
// (StampSheetEntry)の配列へ変換する。
export function parseStampGridWords(words: OcrWord[]): StampSheetEntry[] {
  const columns = clusterIntoColumns(words);
  const entries: StampSheetEntry[] = [];

  for (const column of columns) {
    const lines = clusterIntoLines(column);

    let currentRoom: string | null = null;
    let currentLines: string[] = [];

    const flush = () => {
      if (currentRoom === null) return;
      const parsed = parseScheduleBlockText(currentLines);
      if (parsed) {
        entries.push({
          room_number: currentRoom,
          symbol: parsed.symbol,
          time: '',
          time_end: '',
          note: parsed.note,
          name: '',
          date: parsed.date,
        });
      }
      currentRoom = null;
      currentLines = [];
    };

    for (const line of lines) {
      const text = line.text;
      if (!text) continue;

      if (ROOM_NUMBER_RE.test(text)) {
        // 次の部屋番号行が来た時点で、直前の部屋のブロックを確定させる。
        flush();
        currentRoom = text;
        currentLines = [];
        continue;
      }

      if (currentRoom === null) {
        // まだ最初の部屋番号行に到達していない(表タイトル等)行は無視する。
        continue;
      }
      if (isNoiseLine(text)) {
        // 定型文などの明らかなノイズ行は、部屋の記入内容として取り込まない。
        continue;
      }
      currentLines.push(text);
    }

    // 列の終端(次の部屋番号行が来ないまま列が終わる)でも、最後の部屋のブロックを確定させる。
    flush();
  }

  return entries;
}
