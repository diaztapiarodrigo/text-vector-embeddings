import { Env } from "../types/env";

export type EmbeddingQueueSettings = {
  enabled: boolean;
  batchSize: number;
  delayMs: number;
  maxRetries: number;
  concurrency: number;
  maxTokensPerBatch: number;
};

export const DEFAULT_MAX_TOKENS_PER_BATCH = 60_000;
export const DEFAULT_MAX_DOCUMENTS_PER_BATCH = 128;
export const MAX_SINGLE_DOCUMENT_CHARS = 96_000;

const isQueueEnabledByDefault = true;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CONCURRENCY = 1;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  // Conservative estimate: ~3 characters per token on mixed code/text for Voyage AI
  return Math.ceil(text.length / 3);
}

export function chunkItemsByTokenBudget<T>(
  items: T[],
  getText: (item: T) => string,
  maxTokens: number = DEFAULT_MAX_TOKENS_PER_BATCH,
  maxDocs: number = DEFAULT_MAX_DOCUMENTS_PER_BATCH
): T[][] {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  let currentChunk: T[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const text = getText(item);
    const itemTokens = estimateTokens(text);

    const wouldExceedTokens = currentTokens + itemTokens > maxTokens && currentChunk.length > 0;
    const wouldExceedDocs = currentChunk.length >= maxDocs;

    if (wouldExceedTokens || wouldExceedDocs) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(item);
    currentTokens += itemTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export function getEmbeddingQueueSettings(env: Env): EmbeddingQueueSettings {
  return {
    enabled: parseBoolean(env.EMBEDDINGS_QUEUE_ENABLED, isQueueEnabledByDefault),
    batchSize: parsePositiveInt(env.EMBEDDINGS_QUEUE_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    delayMs: parseNonNegativeInt(env.EMBEDDINGS_QUEUE_DELAY_MS, DEFAULT_DELAY_MS),
    maxRetries: parseNonNegativeInt(env.EMBEDDINGS_QUEUE_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    concurrency: parsePositiveInt(env.EMBEDDINGS_QUEUE_CONCURRENCY, DEFAULT_CONCURRENCY),
    maxTokensPerBatch: parsePositiveInt(env.EMBEDDINGS_QUEUE_MAX_TOKENS_PER_BATCH, DEFAULT_MAX_TOKENS_PER_BATCH),
  };
}

export function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
