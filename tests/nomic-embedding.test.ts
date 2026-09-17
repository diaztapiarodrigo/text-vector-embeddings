import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { Embedding, NOMIC_EMBEDDING_DIM, NOMIC_MODEL } from "../src/adapters/nomic/helpers/embedding";
import { Context } from "../src/types/context";

const SAMPLE_TEXT = "sample text";

describe("Nomic Embedding Adapter", () => {
  let mockContext: Context;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockContext = {
      env: {
        NOMIC_API_KEY: "test-nomic-key",
      },
      logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      },
    } as unknown as Context;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("should create embeddings with correct payload, model, and headers", async () => {
    const dummyEmbedding = new Array(NOMIC_EMBEDDING_DIM).fill(0.123);
    const mockFetch = jest.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const parsedBody = JSON.parse(options?.body as string);
      expect(parsedBody.model).toBe(NOMIC_MODEL);
      expect(parsedBody.texts).toEqual(["test document text"]);
      expect(parsedBody.task_type).toBe("search_document");
      expect(parsedBody.truncation).toBe(true);
      expect((options?.headers as Record<string, string>)?.Authorization).toBe("Bearer test-nomic-key");

      return {
        ok: true,
        json: async () => ({
          embeddings: [dummyEmbedding],
        }),
      } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const embeddingAdapter = new Embedding(mockContext);
    const result = await embeddingAdapter.createEmbedding("test document text", "search_document");

    expect(result).toHaveLength(NOMIC_EMBEDDING_DIM);
    expect(result).toEqual(dummyEmbedding);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should support search_query task_type for queries", async () => {
    const dummyEmbedding = new Array(NOMIC_EMBEDDING_DIM).fill(0.456);
    const mockFetch = jest.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const parsedBody = JSON.parse(options?.body as string);
      expect(parsedBody.task_type).toBe("search_query");

      return {
        ok: true,
        json: async () => ({
          embeddings: [dummyEmbedding],
        }),
      } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const embeddingAdapter = new Embedding(mockContext);
    const result = await embeddingAdapter.createEmbedding("search query text", "search_query");

    expect(result).toHaveLength(NOMIC_EMBEDDING_DIM);
    expect(result).toEqual(dummyEmbedding);
  });

  it("should return empty array when empty texts array is passed", async () => {
    const embeddingAdapter = new Embedding(mockContext);
    const result = await embeddingAdapter.createEmbeddings([]);
    expect(result).toEqual([]);
  });

  it("should throw error if text is null", async () => {
    const embeddingAdapter = new Embedding(mockContext);
    await expect(embeddingAdapter.createEmbedding(null)).rejects.toThrow("Text is null");
  });

  it("should throw error if NOMIC_API_KEY is not defined", async () => {
    mockContext.env.NOMIC_API_KEY = undefined;
    const embeddingAdapter = new Embedding(mockContext);
    await expect(embeddingAdapter.createEmbedding(SAMPLE_TEXT)).rejects.toThrow("NOMIC_API_KEY is not set");
  });

  it("should throw descriptive error on API error response", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized: Invalid API key",
    })) as unknown as typeof fetch;

    const embeddingAdapter = new Embedding(mockContext);
    await expect(embeddingAdapter.createEmbedding(SAMPLE_TEXT)).rejects.toThrow("Nomic API error 401: Unauthorized: Invalid API key");
  });

  it("should warn if returned dimension does not match expected 768", async () => {
    const mismatchedEmbedding = new Array(512).fill(0.5);
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        embeddings: [mismatchedEmbedding],
      }),
    })) as unknown as typeof fetch;

    const embeddingAdapter = new Embedding(mockContext);
    const result = await embeddingAdapter.createEmbedding(SAMPLE_TEXT);

    expect(result).toHaveLength(512);
    expect(mockContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Nomic embedding dimension mismatch. Expected 768, got 512"));
  });
});
