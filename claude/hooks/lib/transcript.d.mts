export type TranscriptEntry = Record<string, unknown>;

export interface PastedImage {
  media_type: string;
  data_base64: string;
  /** The N of "[Image #N]". */
  paste_id: number;
}

export interface Turn {
  prompt: TranscriptEntry;
  promptIndex: number;
  answer: string;
  answeredAt: string | null;
}

export function parseTranscript(text: string): TranscriptEntry[];
export function isHumanPrompt(entry: unknown): boolean;
export function typedFromCommandXml(text: string): string;
export function promptText(entry: unknown): string;
export function isNotesPrompt(entry: unknown): boolean;
export function extractImages(entry: unknown): PastedImage[];
export function findTurn(entries: TranscriptEntry[]): Turn | null;
export function findLatestImagePrompt(entries: TranscriptEntry[]): TranscriptEntry | null;
export function pickPastedImage(images: PastedImage[], n: number): PastedImage | null;
