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

/**
 * Parses a string value as a boolean with a fallback.
 *
 * @param value - The environment variable value to parse.
 * @param fallback - The default fallback boolean value.
 * @returns The parsed boolean result.
 */
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

/**
 * Parses a string value as a strictly positive integer.
 *
 * @param value - The raw string representation of the number.
 * @param fallback - Fallback number if parsing fails or result is non-positive.
 * @returns A positive integer.
 */
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

/**
 * Parses a string value as a non-negative integer (zero or greater).
 *
 * @param value - The raw string representation of the number.
 * @param fallback - Fallback number if parsing fails or result is negative.
 * @returns A non-negative integer.
 */
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

/**
 * Estimates token count for Voyage AI models based on character length.
 * Uses a conservative ratio (~3 characters per token) to safely prevent exceeding Voyage API limits.
 *
 * @param text - The text to estimate tokens for.
 * @returns The estimated token count.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 3);
}

/**
 * Partitions items into sub-batches that do not exceed the token budget or document count cap.
 *
 * @param items - List of items to batch.
 * @param getText - Function extracting the text representation of each item.
 * @param maxTokens - Maximum token budget per sub-batch (default 60,000).
 * @param maxDocs - Maximum number of documents per sub-batch (default 128).
 * @returns Array of sub-batches chunked by token and document budget.
 */
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

    const willExceedTokens = currentTokens + itemTokens > maxTokens && currentChunk.length > 0;
    const willExceedDocs = currentChunk.length >= maxDocs;

    if (willExceedTokens || willExceedDocs) {
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

/**
 * Extracts and validates embedding queue configuration settings from the environment.
 *
 * @param env - The environment variables map.
 * @returns Normalized EmbeddingQueueSettings object.
 */
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

/**
 * Pauses execution for a specified duration.
 *
 * @param ms - Number of milliseconds to sleep.
 * @returns Promise that resolves after the timeout.
 */
export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}
