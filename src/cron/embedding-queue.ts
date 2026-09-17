import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { Embedding as VoyageEmbedding } from "../adapters/voyage/helpers/embedding";
import { DocumentType } from "../types/document";
import { Context } from "../types/context";
import { Database } from "../types/database";
import { Env } from "../types/env";
import { serializeEmbeddingForDatabase } from "../utils/database-embedding";
import {
  chunkItemsByTokenBudget,
  DEFAULT_MAX_DOCUMENTS_PER_BATCH,
  estimateTokens,
  getEmbeddingQueueSettings,
  MAX_SINGLE_DOCUMENT_CHARS,
  sleep,
} from "../utils/embedding-queue";
import { cleanMarkdown, isTooShort, MIN_COMMENT_MARKDOWN_LENGTH, MIN_ISSUE_MARKDOWN_LENGTH } from "../utils/embedding-content";
import { isCommandLikeContent } from "../utils/markdown-comments";

type QueueLogger = {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
};

type QueueClients = {
  supabase: SupabaseClient<Database>;
  voyage: VoyageAIClient;
};

type QueueStats = {
  issuesProcessed: number;
  commentsProcessed: number;
  stoppedEarly: boolean;
};

type QueueLabel = "issues" | "comments" | "documents";

type PendingRow = {
  id: string;
  markdown: string | null;
  modified_at: string | null;
  payload: unknown;
  doc_type: DocumentType;
};

type JsonRecord = Record<string, unknown>;

const MAX_RATE_LIMIT_DELAY_MS = 60_000;

/**
 * Checks whether an error represents an HTTP 429 rate limit failure.
 *
 * @param error - The caught error object.
 * @returns True if the error indicates rate limiting, false otherwise.
 */
function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const statusCode =
      getNestedNumber(error, ["statusCode"]) ??
      getNestedNumber(error, ["status"]) ??
      getNestedNumber(error, ["httpStatus"]) ??
      getNestedNumber(error, ["response", "status"]);
    if (statusCode === 429) {
      return true;
    }
    const body = (error as JsonRecord).body;
    const bodyMessage =
      getNestedString(body, ["error", "message"]) ??
      getNestedString(body, ["message"]) ??
      getNestedString(body, ["error", "type"]) ??
      getNestedString(body, ["error", "code"]);
    if (bodyMessage && bodyMessage.toLowerCase().includes("rate")) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("rate_limit");
}

function getNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as JsonRecord)[key];
  }
  return typeof current === "string" ? current : null;
}

function getNestedNumber(value: unknown, path: string[]): number | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as JsonRecord)[key];
  }
  return typeof current === "number" ? current : null;
}

function getRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const body = (error as JsonRecord).body;
  const retryAfterSeconds =
    getNestedNumber(body, ["retry_after"]) ??
    getNestedNumber(body, ["error", "retry_after"]) ??
    getNestedNumber(body, ["retryAfter"]) ??
    getNestedNumber(body, ["error", "retryAfter"]);
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
    return null;
  }
  return Math.round(retryAfterSeconds * 1000);
}

/**
 * Computes backoff delay in milliseconds based on retry-after headers or exponential backoff.
 *
 * @param baseDelayMs - Base delay in milliseconds.
 * @param attempt - The retry attempt index.
 * @param error - The caught error to inspect for retry-after headers.
 * @returns Milliseconds to wait before retrying.
 */
function getRateLimitDelayMs(baseDelayMs: number, attempt: number, error: unknown): number {
  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }
  if (baseDelayMs <= 0) {
    return 0;
  }
  return Math.min(baseDelayMs * Math.pow(2, attempt), MAX_RATE_LIMIT_DELAY_MS);
}

function isReviewCommentThreadRoot(payload: unknown): boolean {
  const parentId = getNestedNumber(payload, ["comment", "in_reply_to_id"]);
  return parentId === null;
}

function getAuthorType(payload: unknown, docType: DocumentType): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (docType === "issue" || docType === "pull_request") {
    return (
      getNestedString(payload, ["issue", "user", "type"]) ??
      getNestedString(payload, ["pull_request", "user", "type"]) ??
      getNestedString(payload, ["sender", "type"])
    );
  }
  if (docType === "pull_request_review") {
    return getNestedString(payload, ["review", "user", "type"]) ?? getNestedString(payload, ["sender", "type"]);
  }

  return getNestedString(payload, ["comment", "user", "type"]) ?? getNestedString(payload, ["sender", "type"]);
}

async function createEmbeddingsWithRetry(
  embedder: VoyageEmbedding,
  texts: string[],
  maxRetries: number,
  delayMs: number,
  logger: QueueLogger
): Promise<number[][] | null> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await embedder.createEmbeddings(texts);
    } catch (error) {
      if (!isRateLimitError(error)) {
        throw error;
      }
      const backoffMs = getRateLimitDelayMs(delayMs, attempt, error);
      logger.warn("Voyage rate limit hit while creating embeddings batch.", { attempt: attempt + 1, backoffMs });
      if (attempt >= maxRetries) {
        return null;
      }
      await sleep(backoffMs);
      attempt += 1;
    }
  }
  return null;
}

/**
 * Checks whether an error from Voyage AI represents a context length or token limit failure (HTTP 400/413).
 *
 * @param error - The caught error object or exception.
 * @returns True if the error indicates a token limit failure, false otherwise.
 */
export function isTokenLimitError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const statusCode =
      getNestedNumber(error, ["statusCode"]) ??
      getNestedNumber(error, ["status"]) ??
      getNestedNumber(error, ["httpStatus"]) ??
      getNestedNumber(error, ["response", "status"]);
    const body = (error as JsonRecord).body;
    const bodyMessage =
      getNestedString(body, ["error", "message"]) ??
      getNestedString(body, ["message"]) ??
      getNestedString(body, ["detail"]) ??
      getNestedString(body, ["error", "detail"]);
    const msg = (bodyMessage ?? (error instanceof Error ? error.message : String(error ?? ""))).toLowerCase();
    if (
      (statusCode === 400 || statusCode === 413) &&
      (msg.includes("token") ||
        msg.includes("limit") ||
        msg.includes("length") ||
        msg.includes("too large") ||
        msg.includes("too long") ||
        msg.includes("exceed"))
    ) {
      return true;
    }
  }
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    (message.includes("token") &&
      (message.includes("limit") || message.includes("too many") || message.includes("maximum") || message.includes("exceed"))) ||
    message.includes("context length") ||
    message.includes("max input") ||
    message.includes("input too long") ||
    message.includes("request too large") ||
    message.includes("payload too large")
  );
}

/**
 * Truncates an oversized text to a safe character threshold to prevent single-document token overflows.
 *
 * @param text - The raw text content.
 * @param maxChars - The maximum permitted character count.
 * @returns Safe truncated text.
 */
function truncateOversizedText(text: string, maxChars: number = MAX_SINGLE_DOCUMENT_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

/**
 * Attempts to create embeddings for a batch of texts, automatically bisecting into smaller sub-batches
 * upon encountering token limit errors from Voyage AI.
 *
 * @param embedder - The Voyage embedding client.
 * @param texts - Array of document texts to embed.
 * @param settings - Current embedding queue settings.
 * @param logger - Logger instance for operational reporting.
 * @returns Array of embedding vectors, or null if unrecoverable rate limit was exceeded.
 */
async function createEmbeddingsWithBisection(
  embedder: VoyageEmbedding,
  texts: string[],
  settings: ReturnType<typeof getEmbeddingQueueSettings>,
  logger: QueueLogger
): Promise<number[][] | null> {
  if (texts.length === 0) {
    return [];
  }

  try {
    return await createEmbeddingsWithRetry(embedder, texts, settings.maxRetries, settings.delayMs, logger);
  } catch (error) {
    if (isTokenLimitError(error)) {
      if (texts.length > 1) {
        logger.warn("Voyage token limit exceeded for sub-batch; bisecting batch and retrying.", {
          batchSize: texts.length,
          estimatedTokens: texts.reduce((acc, t) => acc + estimateTokens(t), 0),
        });
        const mid = Math.floor(texts.length / 2);
        const leftBatch = texts.slice(0, mid);
        const rightBatch = texts.slice(mid);

        const leftResult = await createEmbeddingsWithBisection(embedder, leftBatch, settings, logger);
        if (leftResult === null) {
          return null;
        }
        const rightResult = await createEmbeddingsWithBisection(embedder, rightBatch, settings, logger);
        if (rightResult === null) {
          return null;
        }
        return [...leftResult, ...rightResult];
      }

      const singleText = texts[0] ?? "";
      if (singleText.length > MAX_SINGLE_DOCUMENT_CHARS) {
        logger.warn("Single document exceeded Voyage token limit; truncating to safe threshold.", {
          originalLength: singleText.length,
          truncatedLength: MAX_SINGLE_DOCUMENT_CHARS,
        });
        const truncated = [truncateOversizedText(singleText, MAX_SINGLE_DOCUMENT_CHARS)];
        return await createEmbeddingsWithRetry(embedder, truncated, settings.maxRetries, settings.delayMs, logger);
      }
    }

    throw error;
  }
}

async function preparePendingRow(params: {
  row: PendingRow;
  label: QueueLabel;
  supabase: SupabaseClient<Database>;
  logger: QueueLogger;
}): Promise<{ row: PendingRow; embeddingSource: string } | null> {
  const { row, label, supabase, logger } = params;
  const docType = row.doc_type as DocumentType;
  const authorType = getAuthorType(row.payload, docType);
  if (authorType && authorType !== "User") {
    const isBotRootReviewAllowed = docType === "review_comment" && isReviewCommentThreadRoot(row.payload);
    if (!isBotRootReviewAllowed) {
      logger.debug("Skipping embedding for non-human author.", { label, id: row.id, authorType, docType });
      const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
      if (updateError) {
        logger.error("Failed to clear markdown for non-human author.", { label, id: row.id, updateError });
      }
      return null;
    }
    logger.debug("Allowing bot-authored root review comment for embedding.", { label, id: row.id, authorType, docType });
  }

  const cleaned = cleanMarkdown(typeof row.markdown === "string" ? row.markdown : null);
  const isIssueDoc = docType === "issue" || docType === "pull_request";
  const minLength = isIssueDoc ? MIN_ISSUE_MARKDOWN_LENGTH : MIN_COMMENT_MARKDOWN_LENGTH;
  if ((docType === "issue_comment" || docType === "review_comment" || docType === "pull_request_review") && isCommandLikeContent(cleaned)) {
    logger.debug("Skipping embedding for command-like comment.", { label, id: row.id, docType });
    const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
    if (updateError) {
      logger.error("Failed to clear markdown for command-like comment.", { label, id: row.id, updateError });
    }
    return null;
  }
  if (!cleaned) {
    logger.debug("Skipping empty markdown embedding.", { label, id: row.id, docType });
    const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
    if (updateError) {
      logger.error("Failed to clear markdown for empty content.", { label, id: row.id, updateError });
    }
    return null;
  }
  if (isTooShort(cleaned, minLength)) {
    logger.debug("Skipping embedding for short content.", { label, id: row.id, length: cleaned.length, minLength, docType });
    const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
    if (updateError) {
      logger.error("Failed to clear markdown for short content.", { label, id: row.id, updateError });
    }
    return null;
  }

  return { row, embeddingSource: cleaned };
}

async function processPendingRows(params: {
  docTypes: DocumentType[];
  label: QueueLabel;
  supabase: SupabaseClient<Database>;
  embedder: VoyageEmbedding;
  settings: ReturnType<typeof getEmbeddingQueueSettings>;
  logger: QueueLogger;
}): Promise<{ processed: number; stoppedEarly: boolean; processedByType: Record<DocumentType, number> }> {
  const { docTypes, label, supabase, embedder, settings, logger } = params;
  const processedByType: Record<DocumentType, number> = {
    issue: 0,
    pull_request: 0,
    issue_comment: 0,
    review_comment: 0,
    pull_request_review: 0,
  };
  const { data, error } = await supabase
    .from("documents")
    .select("id, markdown, modified_at, payload, doc_type")
    .in("doc_type", docTypes)
    .is("embedding", null)
    .is("deleted_at", null)
    .not("markdown", "is", null)
    .order("modified_at", { ascending: true })
    .limit(settings.batchSize);

  if (error) {
    logger.error("Failed to load pending embeddings.", { label, error });
    return { processed: 0, stoppedEarly: false, processedByType };
  }

  if (!data || data.length === 0) {
    return { processed: 0, stoppedEarly: false, processedByType };
  }

  const rows = (data as PendingRow[]).slice();
  const prepared: Array<{ row: PendingRow; embeddingSource: string }> = [];

  for (const row of rows) {
    const result = await preparePendingRow({ row, label, supabase, logger });
    if (result) {
      prepared.push(result);
    }
  }

  if (prepared.length === 0) {
    return { processed: 0, stoppedEarly: false, processedByType };
  }

  const subBatches = chunkItemsByTokenBudget(
    prepared,
    (entry) => entry.embeddingSource,
    settings.maxTokensPerBatch,
    DEFAULT_MAX_DOCUMENTS_PER_BATCH
  );

  const allEmbeddings: number[][] = [];
  for (const subBatch of subBatches) {
    const subBatchTexts = subBatch.map((entry) => truncateOversizedText(entry.embeddingSource));
    const subEmbeddings = await createEmbeddingsWithBisection(embedder, subBatchTexts, settings, logger);
    if (!subEmbeddings) {
      return { processed: 0, stoppedEarly: true, processedByType };
    }
    if (subEmbeddings.length !== subBatch.length) {
      logger.error("Embedding batch response size mismatch.", {
        label,
        expected: subBatch.length,
        received: subEmbeddings.length,
      });
      return { processed: 0, stoppedEarly: true, processedByType };
    }
    allEmbeddings.push(...subEmbeddings);
  }

  const updates = prepared.map((entry, index) => ({
    row: entry.row,
    embedding: allEmbeddings[index] ?? [],
  }));

  let processed = 0;
  const concurrency = Math.max(1, Math.min(settings.concurrency, updates.length));

  async function worker() {
    while (updates.length > 0) {
      const update = updates.shift();
      if (!update) {
        return;
      }
      if (!update.embedding.length) {
        logger.error("Embedding batch returned empty vector.", { label, id: update.row.id });
        const { error: clearError } = await supabase
          .from("documents")
          .update({ markdown: null, modified_at: new Date().toISOString() })
          .eq("id", update.row.id);
        if (clearError) {
          logger.error("Failed to clear markdown after empty embedding.", {
            label,
            id: update.row.id,
            clearError,
          });
        }
        continue;
      }
      const { error: updateError } = await supabase
        .from("documents")
        .update({ embedding: serializeEmbeddingForDatabase(update.embedding), modified_at: new Date().toISOString() })
        .eq("id", update.row.id);

      if (updateError) {
        logger.error("Failed to update embedding.", { label, id: update.row.id, updateError });
        continue;
      }
      const docType = update.row.doc_type as DocumentType;
      if (processedByType[docType] !== undefined) {
        processedByType[docType] += 1;
      }
      processed += 1;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (processed > 0) {
    await sleep(settings.delayMs);
  }

  return { processed, stoppedEarly: false, processedByType };
}

export async function processPendingEmbeddings(params: { env: Env; clients: QueueClients; logger: QueueLogger }): Promise<QueueStats> {
  const { env, clients, logger } = params;
  const settings = getEmbeddingQueueSettings(env);

  if (!settings.enabled) {
    logger.debug("Embedding queue disabled; skipping pending embeddings.");
    return { issuesProcessed: 0, commentsProcessed: 0, stoppedEarly: false };
  }

  const embedder = new VoyageEmbedding(clients.voyage, { logger } as unknown as Context);

  const combinedResult = await processPendingRows({
    docTypes: ["issue", "pull_request", "issue_comment", "review_comment", "pull_request_review"],
    label: "documents",
    supabase: clients.supabase,
    embedder,
    settings,
    logger,
  });

  const issuesProcessed = (combinedResult.processedByType.issue ?? 0) + (combinedResult.processedByType.pull_request ?? 0);
  const commentsProcessed =
    (combinedResult.processedByType.issue_comment ?? 0) +
    (combinedResult.processedByType.review_comment ?? 0) +
    (combinedResult.processedByType.pull_request_review ?? 0);

  return {
    issuesProcessed,
    commentsProcessed,
    stoppedEarly: combinedResult.stoppedEarly,
  };
}
