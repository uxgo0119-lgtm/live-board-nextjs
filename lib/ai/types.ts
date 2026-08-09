// [2026-07-20新設 / 2026-07-20改訂] プロバイダ非依存の「AI機能(Capability)」共通型。
//
// 設計意図: 「Claude専用アプリ」ではなく「FireFlowというサービスとしてAIを自由に
// 入れ替えられる」ことを目指すため、Route Handler / lib/ai/capabilities/ 配下は
// この型だけを見て実装する。実際にどのプロバイダ(Anthropic/OpenAI/Gemini等)が
// 処理するかは lib/ai/providers/ 配下に閉じ込め、lib/ai/router.ts が
// タスク名→プロバイダを解決する。

export type OcrMode = 'single' | 'bulk';

// capabilities層からprovider実装(Adapter)へ渡す入力。プロンプト文言・トークン上限
// といった「タスク固有の知識」はcapabilities層が組み立て、provider実装は
// それをそのプロバイダのAPI形式に変換して呼び出すだけにする。
export type OcrInput = {
  mode: OcrMode;
  mediaType: string;
  data: string; // base64
  promptText: string;
  maxTokens: number;
};

export type OcrOutput = unknown; // 実際の形状(単一/配列)の検証はcapabilities層が行う

// OCR機能のポート(Port)。各プロバイダのAdapter(例: providers/anthropic/ocr.ts)が
// この interface を実装する。
export interface OcrCapability {
  scan(input: OcrInput): Promise<OcrOutput>;
}

// ---- 以下、現時点では未実装(型のみ)。将来「AI文章生成」「AI画像解析」などの
// capabilityを追加する際、迷わず同じ形で拡張できるようにするための下地。----

export type TextGenerationInput = {
  promptText: string;
  maxTokens: number;
};
export type TextGenerationOutput = string;
export interface TextGenerationCapability {
  generate(input: TextGenerationInput): Promise<TextGenerationOutput>;
}

export type ImageAnalysisInput = {
  mediaType: string;
  data: string; // base64
  promptText: string;
  maxTokens: number;
};
export type ImageAnalysisOutput = unknown;
export interface ImageAnalysisCapability {
  analyze(input: ImageAnalysisInput): Promise<ImageAnalysisOutput>;
}

// 点検希望時間連絡票OCRの結果形状(mode:'single'なら単一オブジェクト、
// mode:'bulk'ならその配列)。
export type ScheduleOcrResult = {
  room_number: string;
  symbol: string;
  time: string;
  time_end: string;
  note: string;
  name: string;
};

// [2026-07-27新設 Phase7] 「紙の点検予定表」帳票(inspectionScheduleSheet)OCRの、
// 部屋1件分の生の読み取り結果。
//
// 【重要・設計判断】このフィールド名は、ブラウザ側のダミーOCR実装
// (lb_tool/ocr_intake/mock_ocr_provider.js の getMockOcrRawResult() が返す rawRooms の
// 各要素)と一字一句そろえてある。こうすることで、サーバー側の実OCR APIレスポンスを
// フィールド名の変換層なしにそのまま lb_tool/ocr_intake/normalize/
// normalizeInspectionScheduleSheet.js へ渡せる(ocr_intake/real_ocr_provider.js は
// 基本的にAPIレスポンスを右から左へ受け渡すだけでよい設計にしている)。将来サーバー側の
// JSON形状を変える場合は、この型とmock_ocr_provider.jsの両方を同時に見直すか、変換
// アダプタを別途設けることを検討すること。
//
// 【重要・信頼度について】confidenceはAIモデルに自己評価させた値であり、統計的に
// キャリブレーションされた確率(例:0.9なら実際に90%の確率で正しい)ではない。あくまで
// モデル自身が申告した「それらしい自信度」に過ぎず、実際の正解率とは乖離しうる参考値
// として扱うこと(UI側で「要確認」の目安に使うのは妥当だが、確信度の数値そのものを
// 正確な確率として扱ってはいけない)。
export type InspectionScheduleSheetOcrRoomResult = {
  roomNumberRaw: string | null;
  scheduleDayRaw: string | null;
  periodRaw: string | null;
  timeRaw: string | null;
  noteRaw: string | null;
  statusRaw: string | null;
  ladderRaw: string | null;
  memoRaw: string | null;
  confidence: {
    roomNumber?: number;
    scheduleDay?: number;
    period?: number;
    time?: number;
    status?: number;
  };
};
