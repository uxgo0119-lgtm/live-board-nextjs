// lib/ocr-benchmark/googleAuth.ts
//
// [2026-07-28新設] OCRベンチマーク専用のGoogle Cloud認証ヘルパー。
//
// 【重要】このファイルは本番のOCR経路(app/api/scan-time-request/route.ts →
// lib/handlers/scanInspectionSchedule.ts → lib/ai/capabilities/ocr/documentTypes/
// residentTimeRequestSheet.ts、いずれもAnthropic/Claudeベース)とは完全に独立している。
// 本番経路は一切参照しないし、本番経路からも一切参照されない。
//
// 読み取る環境変数:
//   - GOOGLE_APPLICATION_CREDENTIALS_JSON: サービスアカウントJSON鍵の中身をそのまま
//     1行文字列にしたもの(JSON.parseできる文字列)。
//   - GOOGLE_CLOUD_PROJECT_ID: GCPのプロジェクトID。
//   - DOCUMENT_AI_LOCATION: Document AIプロセッサのロケーション(例: 'us' 'eu' 'asia-northeast1' 等)。
//   - DOCUMENT_AI_OCR_PROCESSOR_ID: Document OCRプロセッサのID。
//
// 【@google-cloud/vision・@google-cloud/documentaiを静的importしない理由】
// この作業を行った時点では、まだGoogle Cloudの認証情報がこの環境に設定されておらず
// (ユーザーが別途Google Cloudコンソールで準備中)、依存パッケージのインストールも
// サンドボックスのネットワークegress許可リストの制約(registry.npmjs.orgが
// このサンドボックスからは到達不可)で完了できなかった(package.jsonへの追記は実施済み。
// 詳細は完了報告を参照)。パッケージが未インストールの状態で誤ってこのファイルが
// importされても「Cannot find module」という生のNode.jsスタックトレースでアプリ全体が
// クラッシュしないよう、SDK本体は各ファクトリ関数の呼び出し時にのみ動的import()する。
// さらに、import()の引数を文字列リテラルではなく変数経由で渡すことで、TypeScriptの
// 静的な型解決の対象からも外している(動的import()はモジュール指定子が文字列リテラルの
// 場合のみ型解決を試みるため、変数を渡すとPromise<any>として扱われ、パッケージが
// node_modulesに存在しなくても `tsc --noEmit` が通る)。その代わり、戻り値は
// このファイル内で手作業で定義した最小限の型(VisionClientLike/DocumentAiClientLike、
// 実際のAPIレスポンス形状に基づく)へキャストし直すことで、呼び出し側
// (visionOcr.ts/documentAiOcr.ts)の型安全性を確保している。
// パッケージが実際にインストールされ、認証情報も設定された本番運用時は、この動的importが
// そのまま実物の@google-cloud/vision・@google-cloud/documentaiを読み込み、正しく動作する。

export class OcrBenchmarkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrBenchmarkConfigError';
  }
}

export interface GoogleCloudBenchmarkConfig {
  credentials: Record<string, unknown>;
  projectId: string;
  documentAiLocation: string;
  documentAiProcessorId: string;
}

function requiredEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (!v) {
    throw new OcrBenchmarkConfigError(
      `${name}が未設定です。.env.localを確認してください。${hint}`
    );
  }
  return v;
}

// 4つの環境変数をまとめて検証・組み立てる。呼び出す都度process.envを読み直す
// (lib/config/env.tsのようなプロセス内キャッシュは、ベンチマークCLIが1回実行して終わる
// 用途のため不要と判断し、あえて持たせていない)。
export function getGoogleCloudBenchmarkConfig(): GoogleCloudBenchmarkConfig {
  const credentialsRaw = requiredEnv(
    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
    'Google Cloudコンソールでサービスアカウントを作成し、鍵(JSON形式)をダウンロードして、' +
      'そのファイルの中身をそのまま1行の文字列にしたものを設定してください。'
  );
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(credentialsRaw);
  } catch (err) {
    throw new OcrBenchmarkConfigError(
      'GOOGLE_APPLICATION_CREDENTIALS_JSONの内容がJSONとして解析できませんでした。' +
        'サービスアカウント鍵JSONファイルの中身をそのまま1行の文字列にして設定してください' +
        `(${err instanceof Error ? err.message : String(err)})。`
    );
  }
  return {
    credentials,
    projectId: requiredEnv('GOOGLE_CLOUD_PROJECT_ID', 'GCPのプロジェクトIDを設定してください。'),
    documentAiLocation: requiredEnv(
      'DOCUMENT_AI_LOCATION',
      "Document AIプロセッサのロケーション(例: 'us'・'eu'・'asia-northeast1')を設定してください。"
    ),
    documentAiProcessorId: requiredEnv(
      'DOCUMENT_AI_OCR_PROCESSOR_ID',
      'Document AIコンソールで作成したDocument OCRプロセッサのIDを設定してください。'
    ),
  };
}

// --- Vision APIレスポンスの最小限の型(実際のAPIレスポンス形状に基づき手作業で定義) ---

export interface VisionVertexLike {
  x?: number | null;
  y?: number | null;
}

export interface VisionWordLike {
  symbols?: Array<{ text?: string | null }>;
  boundingBox?: { vertices?: VisionVertexLike[] | null; normalizedVertices?: VisionVertexLike[] | null } | null;
}

export interface VisionPageLike {
  width?: number | null;
  height?: number | null;
  blocks?: Array<{
    paragraphs?: Array<{
      words?: VisionWordLike[];
    }>;
  }>;
}

export interface VisionAnnotateImageResponseLike {
  fullTextAnnotation?: {
    text?: string;
    pages?: VisionPageLike[];
  } | null;
  error?: { message?: string } | null;
}

export interface VisionClientLike {
  documentTextDetection(request: {
    image: { content: string } | { source: { imageUri: string } };
  }): Promise<[VisionAnnotateImageResponseLike, unknown, unknown]>;
}

// --- Document AIレスポンスの最小限の型 ---

export interface DocumentAiTextSegmentLike {
  startIndex?: string | number | null;
  endIndex?: string | number | null;
}

export interface DocumentAiTokenLike {
  layout?: {
    textAnchor?: { textSegments?: DocumentAiTextSegmentLike[] } | null;
    boundingPoly?: { normalizedVertices?: VisionVertexLike[] | null; vertices?: VisionVertexLike[] | null } | null;
  } | null;
}

export interface DocumentAiPageLike {
  tokens?: DocumentAiTokenLike[];
}

export interface DocumentAiDocumentLike {
  text?: string;
  pages?: DocumentAiPageLike[];
}

export interface DocumentAiProcessResponseLike {
  document?: DocumentAiDocumentLike | null;
}

export interface DocumentAiClientLike {
  processDocument(request: {
    name: string;
    rawDocument: { content: string; mimeType: string };
  }): Promise<[DocumentAiProcessResponseLike, unknown, unknown]>;
}

// モジュール指定子を変数経由で渡すことで動的import()の型解決を意図的に避けている
// (このファイル冒頭のコメント参照)。
async function dynamicImportByVariable(moduleName: string): Promise<any> {
  return import(moduleName);
}

export async function createVisionClient(): Promise<VisionClientLike> {
  const config = getGoogleCloudBenchmarkConfig();
  let mod: any;
  try {
    mod = await dynamicImportByVariable('@google-cloud/vision');
  } catch (err) {
    throw new OcrBenchmarkConfigError(
      '@google-cloud/visionパッケージが見つかりません。package.jsonに追加した上で ' +
        'npm install を実行してください' +
        `(元エラー: ${err instanceof Error ? err.message : String(err)})。`
    );
  }
  const ImageAnnotatorClient = mod.ImageAnnotatorClient || mod.v1?.ImageAnnotatorClient;
  if (!ImageAnnotatorClient) {
    throw new OcrBenchmarkConfigError(
      '@google-cloud/visionからImageAnnotatorClientを取得できませんでした。' +
        'パッケージのバージョンを確認してください。'
    );
  }
  return new ImageAnnotatorClient({
    projectId: config.projectId,
    credentials: config.credentials,
  }) as VisionClientLike;
}

export interface DocumentAiClientBundle {
  client: DocumentAiClientLike;
  processorName: string;
}

export async function createDocumentAiClient(): Promise<DocumentAiClientBundle> {
  const config = getGoogleCloudBenchmarkConfig();
  let mod: any;
  try {
    mod = await dynamicImportByVariable('@google-cloud/documentai');
  } catch (err) {
    throw new OcrBenchmarkConfigError(
      '@google-cloud/documentaiパッケージが見つかりません。package.jsonに追加した上で ' +
        'npm install を実行してください' +
        `(元エラー: ${err instanceof Error ? err.message : String(err)})。`
    );
  }
  const DocumentProcessorServiceClient = mod.DocumentProcessorServiceClient || mod.v1?.DocumentProcessorServiceClient;
  if (!DocumentProcessorServiceClient) {
    throw new OcrBenchmarkConfigError(
      '@google-cloud/documentaiからDocumentProcessorServiceClientを取得できませんでした。' +
        'パッケージのバージョンを確認してください。'
    );
  }
  const client = new DocumentProcessorServiceClient({
    projectId: config.projectId,
    credentials: config.credentials,
  }) as DocumentAiClientLike;
  const processorName = `projects/${config.projectId}/locations/${config.documentAiLocation}/processors/${config.documentAiProcessorId}`;
  return { client, processorName };
}
