// lib/ocr-benchmark/documentAiOcr.ts
//
// [2026-07-28新設] Google Document AI(Document OCRプロセッサ、processDocument)の呼び出し
// ラッパー。PDF・JPEG両方の入力に対応する(mimeTypeをそのまま渡す)。
//
// Vision側(visionOcr.ts)と同様、レスポンス変換ロジック(extractWordsFromDocumentAiResponse)を
// 実際のAPI呼び出しから独立した純粋関数として切り出してあり、認証情報が無い環境でも
// オフラインでテストできる。

import { readFileSync } from 'node:fs';
import { createDocumentAiClient } from './googleAuth';
import type { DocumentAiPageLike, DocumentAiProcessResponseLike, VisionVertexLike } from './googleAuth';
import type { OcrBoundingBox, OcrPageResult, OcrProviderResult, OcrWord } from './types';

export interface DocumentAiOcrInput {
  base64?: string;
  filePath?: string;
  // 'application/pdf' | 'image/jpeg' | 'image/png' 等。Document AIのrawDocument.mimeTypeへ
  // そのまま渡す。
  mimeType: string;
}

function resolveBase64(input: DocumentAiOcrInput): string {
  if (input.base64) return input.base64;
  if (input.filePath) return readFileSync(input.filePath).toString('base64');
  throw new Error('DocumentAiOcrInputにはbase64かfilePathのいずれかを指定してください。');
}

// Document AIは「単語の文字列そのもの」ではなく、全文(document.text)への
// startIndex/endIndex参照(textSegments)として単語を表現する。startIndex/endIndexは
// int64のためJSONでは文字列で返ることがある(gRPC-Web/JSON表現の仕様)ため、Number()で
// 変換してから文字列を切り出す。
function textForSegments(
  fullText: string,
  segments: Array<{ startIndex?: string | number | null; endIndex?: string | number | null }> | null | undefined
): string {
  if (!segments || segments.length === 0) return '';
  return segments
    .map((seg) => {
      const start = Number(seg.startIndex || 0);
      const end = Number(seg.endIndex || 0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
      return fullText.slice(start, end);
    })
    .join('');
}

// Document AIのnormalizedVerticesは既に0〜1の正規化値で返るため、無変換でそのまま使える
// (lib/ocr-benchmark/types.tsのコメント参照: 共通中間形式の座標系はこれに合わせてある)。
function boundingBoxFromNormalizedVertices(vertices: VisionVertexLike[] | null | undefined): OcrBoundingBox {
  const pts = (vertices || []).map((v) => ({ x: v.x || 0, y: v.y || 0 }));
  if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface DocumentAiExtraction {
  words: OcrWord[];
  pages: OcrPageResult[];
  rawText: string;
}

// 純粋関数: Document AIレスポンス(またはそれと同じ形のダミーレスポンス)から、
// 共通中間形式(単語+正規化座標)を組み立てる。ネットワーク呼び出しを一切行わない。
export function extractWordsFromDocumentAiResponse(response: DocumentAiProcessResponseLike): DocumentAiExtraction {
  const doc = response.document || {};
  const fullText = doc.text || '';
  const pages: DocumentAiPageLike[] = doc.pages || [];
  const outPages: OcrPageResult[] = [];
  const allWords: OcrWord[] = [];

  for (const page of pages) {
    const pageWords: OcrWord[] = [];
    for (const token of page.tokens || []) {
      const text = textForSegments(fullText, token.layout?.textAnchor?.textSegments).trim();
      if (!text) continue;
      const vertices = token.layout?.boundingPoly?.normalizedVertices;
      const boundingBox = boundingBoxFromNormalizedVertices(vertices);
      const w: OcrWord = { text, boundingBox };
      pageWords.push(w);
      allWords.push(w);
    }
    outPages.push({ words: pageWords });
  }

  return { words: allWords, pages: outPages, rawText: fullText };
}

// 実際にDocument AI(Document OCRプロセッサ)を呼び出す関数。Google Cloudの認証情報が
// 無い/依存パッケージがインストールされていない環境では、createDocumentAiClient()が
// OcrBenchmarkConfigErrorを投げる(googleAuth.ts参照)。
export async function runDocumentAiOcr(input: DocumentAiOcrInput): Promise<OcrProviderResult> {
  const { client, processorName } = await createDocumentAiClient();
  const content = resolveBase64(input);
  const started = Date.now();
  const [response] = await client.processDocument({
    name: processorName,
    rawDocument: { content, mimeType: input.mimeType },
  });
  const processingTimeMs = Date.now() - started;

  const extraction = extractWordsFromDocumentAiResponse(response);

  return {
    provider: 'documentai',
    words: extraction.words,
    pages: extraction.pages,
    processingTimeMs,
    rawText: extraction.rawText,
  };
}
