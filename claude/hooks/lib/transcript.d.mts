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
  images: PastedImage[];
}

export interface ImagePrompt {
  entry: TranscriptEntry;
  images: PastedImage[];
}

export function parseTranscript(text: string): TranscriptEntry[];
export function isHumanPrompt(entry: unknown): boolean;
export function typedFromCommandXml(text: string): string;
export function promptText(entry: unknown): string;
export function isNotesPrompt(entry: unknown): boolean;
export function isNotesPromptText(text: unknown): boolean;
export function extractImages(entry: unknown): PastedImage[];
export function findTurn(entries: TranscriptEntry[]): Turn | null;
export function findLatestImagePrompt(entries: TranscriptEntry[]): TranscriptEntry | null;
export function findLatestPromptImages(entries: TranscriptEntry[]): { entry: TranscriptEntry; images: PastedImage[] } | null;
export function promptImages(entries: TranscriptEntry[], index: number): PastedImage[];
export function listImagePrompts(entries: TranscriptEntry[]): ImagePrompt[];
export function pickPastedImage(images: PastedImage[], n: number): PastedImage | null;
