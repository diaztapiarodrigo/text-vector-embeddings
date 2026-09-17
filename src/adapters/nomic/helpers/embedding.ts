import { Context } from "../../../types/context";
import { SuperNomic } from "./nomic";

export const NOMIC_EMBEDDING_DIM = 768;
export const NOMIC_MODEL = "nomic-embed-text-v1.5";

export type NomicEmbeddingTaskType = "search_document" | "search_query" | "classification" | "clustering";

export class Embedding extends SuperNomic {
  constructor(context: Context) {
    super(context);
  }

  /**
   * Creates a single embedding for the given text.
   */
  async createEmbedding(text: string | null, inputType: NomicEmbeddingTaskType = "search_document"): Promise<number[]> {
    if (text === null) {
      throw new Error("Text is null");
    }
    const embeddings = await this.createEmbeddings([text], inputType);
    return embeddings[0] ?? [];
  }

  /**
   * Creates multiple embeddings in a single API call.
   */
  async createEmbeddings(texts: string[], inputType: NomicEmbeddingTaskType = "search_document"): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const apiKey = this.context.env.NOMIC_API_KEY;
    if (!apiKey) {
      throw new Error("NOMIC_API_KEY is not set");
    }

    const response = await fetch("https://api-atlas.nomic.ai/v1/embedding/text", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        texts,
        model: NOMIC_MODEL,
        task_type: inputType,
        truncation: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Nomic API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error("Invalid response from Nomic API: missing embeddings array");
    }

    const dims = data.embeddings[0]?.length;
    if (dims !== NOMIC_EMBEDDING_DIM) {
      this.context.logger.warn(`Nomic embedding dimension mismatch. Expected ${NOMIC_EMBEDDING_DIM}, got ${dims}`);
    }

    return data.embeddings;
  }
}
