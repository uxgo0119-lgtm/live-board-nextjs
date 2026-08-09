// lib/ocr-benchmark/visionOcr.ts
//
// [2026-07-28新設] Google Cloud Vision API(documentTextDetection)の呼び出しラッパー。
// 単なるtextDetectionではなく、文書向けのdocumentTextDetectionを使う(手書き文字認識精度が
// 高いため、指示書の通り)。
//
// レスポンス変換ロジック(extractWordsFromVisionResponse)は、実際のAPI呼び出し
// (runVisionDocumentTextDetection)から independent な純粋関数として切り出してある。
// これにより、Google Cloudの認証情報が無い環境でも、「Vision APIが実際に返しそうな形の
// レスポンスJSON」をテストコードで手作業で組み立て、この変換ロジックだけをオフラインで
// 検証できる(test/unit/ocr-benchmark/stampGridParser.test.ts 参照)。

import { readFileSync } from 'node:fs';
import { createVisionClient } from './googleAuth';
import type { VisionAnnotateImageResponseLike, VisionPageLike, VisionWordLike } from './googleAuth';
import type { OcrBoundingBox, OcrPageResult, OcrProviderResult, OcrWord } from './types';

export interface VisionOcrInput {
  base64?: string;
  filePath?: string;
}

function resolveBase64(input: VisionOcrInput): string {
  if (input.base64) return input.base64;
  if (input.filePath) return readFileSync(input.filePath).toString('base64');
  throw new Error('VisionOcrInputにはbase64かfilePathのいずれかを指定してください。');
}

function wordText(word: VisionWordLike): string {
  return (word.symbols || []).map((s) => s.text || '').join('');
}

// Vision APIのboundingBox(vertices、ピクセル単位)を、ページ幅・高さで割って0〜1の
// 正規化座標へ変換する。lib/ocr-benchmark/types.tsのコメント参照(共通中間形式の設計意図)。
function boundingBoxFromPixelVertices(
  vertices: Array<{ x?: number | null; y?: number | null }> | null | undefined,
  pageWidthPx: number,
  pageHeightPx: number
): OcrBoundingBox {
  const pts = (vertices || []).map((v) => ({ x: v.x || 0, y: v.y || 0 }));
  if (pts.length === 0 || !pageWidthPx || !pageHeightPx) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX / pageWidthPx,
    y: minY / pageHeightPx,
    width: (maxX - minX) / pageWidthPx,
    height: (maxY - minY) / pageHeightPx,
  };
}

export interface VisionExtraction {
  words: OcrWord[];
  pages: OcrPageResult[];
  rawText: string;
}

// 純粋関数: Vision APIレスポンス(またはそれと同じ形のダミーレスポンス)から、
// 共通中間形式(単語+正規化座標)を組み立てる。ネットワーク呼び出しを一切行わない。
export function extractWordsFromVisionResponse(response: VisionAnnotateImageResponseLike): VisionExtraction {
  if (response.error && response.error.message) {
    throw new Error(`Vision APIエラー: ${response.error.message}`);
  }

  const pages: VisionPageLike[] = (response.fullTextAnnotation && response.fullTextAnnotation.pages) || [];
  const outPages: OcrPageResult[] = [];
  const allWords: OcrWord[] = [];

  for (const page of pages) {
    const pageWidthPx = page.width || 0;
    const pageHeightPx = page.height || 0;
    const pageWords: OcrWord[] = [];
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = wordText(word).trim();
          if (!text) continue;
          const boundingBox = boundingBoxFromPixelVertices(word.boundingBox?.vertices, pageWidthPx, pageHeightPx);
          const w: OcrWord = { text, boundingBox };
          pageWords.push(w);
          allWords.push(w);
        }
      }
    }
    outPages.push({ words: pageWords, pageWidthPx, pageHeightPx });
  }

  return {
    words: allWords,
    pages: outPages,
    rawText: (response.fullTextAnnotation && response.fullTextAnnotation.text) || '',
  };
}

// 実際にVision APIを呼び出す関数。Google Cloudの認証情報が無い/依存パッケージが
// インストールされていない環境では、createVisionClient()がOcrBenchmarkConfigErrorを
// 投げる(googleAuth.ts参照)。
export async function runVisionDocumentTextDetection(input: VisionOcrInput): Promise<OcrProviderResult> {
  const client = await createVisionClient();
  const content = resolveBase64(input);
  const started = Date.now();
  const [response] = await client.documentTextDetection({ image: { content } });
  const processingTimeMs = Date.now() - started;

  const extraction = extractWordsFromVisionResponse(response);

  return {
    provider: 'vision',
    words: extraction.words,
    pages: extraction.pages,
    processingTimeMs,
    rawText: extraction.rawText,
  };
}
