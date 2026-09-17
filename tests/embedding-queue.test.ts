import { describe, expect, it, mock } from "bun:test";
import { SupabaseClient } from "@supabase/supabase-js";
import { processPendingEmbeddings } from "../src/cron/embedding-queue";
import { Database } from "../src/types/database";
import { Env } from "../src/types/index";

type QueueRow = {
  id: string;
  markdown: string | null;
  modified_at: string;
  payload: Record<string, unknown> | null;
  doc_type: string;
};

function createMockSupabase(selectBatches: QueueRow[][]) {
  const capturedDocTypes: string[][] = [];
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  let selectCall = 0;

  const selectBuilder = {
    in: (field: string, docTypes: string[]) => {
      void field;
      capturedDocTypes.push(docTypes);
      return selectBuilder;
    },
    is: () => selectBuilder,
    not: () => selectBuilder,
    order: () => selectBuilder,
    limit: async () => ({
      data: selectBatches[selectCall++] ?? [],
      error: null,
    }),
  };

  const client = {
    from: (table: string) => {
      void table;
      return {
        select: (columns?: string) => {
          void columns;
          return selectBuilder;
        },
        update: (values: Record<string, unknown>) => ({
          eq: async (field: string, id: string) => {
            void field;
            updates.push({ id, values });
            return { error: null };
          },
        }),
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { client, capturedDocTypes, updates };
}

function createLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

describe("processPendingEmbeddings", () => {
  it("processes pull request documents with issue-length thresholds", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
    } as Env;
    const prRow: QueueRow = {
      id: "pr-1",
      markdown: "x".repeat(40),
      modified_at: new Date().toISOString(),
      payload: { pull_request: { user: { type: "User" } } },
      doc_type: "pull_request",
    };
    const { client, capturedDocTypes, updates } = createMockSupabase([[prRow], []]);
    const voyage = {
      embed: mock(async () => ({ data: [{ embedding: [1, 2, 3] }] })),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(1);
    expect(result.commentsProcessed).toBe(0);
    expect(result.stoppedEarly).toBe(false);
    expect(capturedDocTypes[0]).toContain("pull_request");
    expect(updates.length).toBe(1);
  });

  it("marks the queue as stopped when rate limits persist", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
      EMBEDDINGS_QUEUE_MAX_RETRIES: "0",
    } as Env;
    const issueRow: QueueRow = {
      id: "issue-1",
      markdown: "y".repeat(80),
      modified_at: new Date().toISOString(),
      payload: { issue: { user: { type: "User" } } },
      doc_type: "issue",
    };
    const { client, updates } = createMockSupabase([[issueRow], []]);
    const voyage = {
      embed: mock(async () => {
        throw new Error("rate limit exceeded");
      }),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(0);
    expect(result.stoppedEarly).toBe(true);
    expect(updates.length).toBe(0);
  });

  it("allows bot-authored root review comments through the queue", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
    } as Env;
    const reviewRow: QueueRow = {
      id: "review-root",
      markdown: "z".repeat(80),
      modified_at: new Date().toISOString(),
      payload: { comment: { user: { type: "Bot" }, in_reply_to_id: null } },
      doc_type: "review_comment",
    };
    const { client, updates } = createMockSupabase([[reviewRow]]);
    const voyage = {
      embed: mock(async () => ({ data: [{ embedding: [1, 2, 3] }] })),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.commentsProcessed).toBe(1);
    expect(updates.length).toBe(1);
  });

  it("splits batches proactively by token budget into multiple voyage requests", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
      EMBEDDINGS_QUEUE_MAX_TOKENS_PER_BATCH: "60",
    } as Env;

    // 4 rows, each with 90 characters (~30 tokens each).
    // With maxTokensPerBatch = 60, only 2 items fit per sub-batch.
    const rows: QueueRow[] = [
      {
        id: "issue-1",
        markdown: "a".repeat(90),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
      {
        id: "issue-2",
        markdown: "b".repeat(90),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
      {
        id: "issue-3",
        markdown: "c".repeat(90),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
      {
        id: "issue-4",
        markdown: "d".repeat(90),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
    ];

    const { client, updates } = createMockSupabase([rows, []]);
    const calls: Array<{ input: string[] }> = [];
    const voyage = {
      embed: mock(async (params: { input: string[] }) => {
        calls.push(params);
        return { data: params.input.map(() => ({ embedding: [0.1, 0.2] })) };
      }),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(4);
    expect(result.stoppedEarly).toBe(false);
    expect(updates.length).toBe(4);
    // Should have split 4 rows into 2 requests of 2 items each
    expect(calls.length).toBe(2);
    expect(calls[0].input.length).toBe(2);
    expect(calls[1].input.length).toBe(2);
  });

  it("dynamically bisects and retries when Voyage returns a 400 token limit error", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
    } as Env;

    const rows: QueueRow[] = [
      {
        id: "issue-1",
        markdown: "doc1 ".repeat(20),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
      {
        id: "issue-2",
        markdown: "doc2 ".repeat(20),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
    ];

    const { client, updates } = createMockSupabase([rows, []]);
    const calls: Array<{ input: string[] }> = [];
    const voyage = {
      embed: mock(async (params: { input: string[] }) => {
        calls.push(params);
        // Throw Voyage 400 token limit error when given 2 or more inputs
        if (params.input.length > 1) {
          const err = new Error("Request exceeds Voyage model token limit of 120,000 tokens.");
          (err as unknown as { statusCode: number }).statusCode = 400;
          throw err;
        }
        return { data: params.input.map(() => ({ embedding: [0.3, 0.4] })) };
      }),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(2);
    expect(result.stoppedEarly).toBe(false);
    expect(updates.length).toBe(2);
    // Initial call failed with 2 items, then 2 bisected calls with 1 item each succeeded
    expect(calls.length).toBe(3);
    expect(calls[0].input.length).toBe(2);
    expect(calls[1].input.length).toBe(1);
    expect(calls[2].input.length).toBe(1);
  });

  it("recovers and completes oversized mixed-length batches", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
    } as Env;

    const rows: QueueRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `doc-${i}`,
      markdown: `Content ${i} `.repeat(i % 2 === 0 ? 30 : 15),
      modified_at: new Date().toISOString(),
      payload: { issue: { user: { type: "User" } } },
      doc_type: "issue",
    }));

    const { client, updates } = createMockSupabase([rows, []]);
    const voyage = {
      embed: mock(async (params: { input: string[] }) => {
        // Any batch larger than 3 items fails with token limit error
        if (params.input.length > 3) {
          const err = new Error("Token limit reached for batch size");
          (err as unknown as { statusCode: number }).statusCode = 400;
          throw err;
        }
        return { data: params.input.map(() => ({ embedding: [0.5, 0.6] })) };
      }),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(10);
    expect(result.stoppedEarly).toBe(false);
    expect(updates.length).toBe(10);
  });
});
