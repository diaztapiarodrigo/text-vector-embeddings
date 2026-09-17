import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { IssueDocumentType, ISSUE_DOCUMENT_TYPES } from "../../../types/document";
import { serializeEmbeddingForDatabase } from "../../../utils/database-embedding";
import { cleanMarkdown, isTooShort, MIN_ISSUE_MARKDOWN_LENGTH } from "../../../utils/embedding-content";

export interface IssueType {
  id: string;
  doc_type?: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[] | null;
  deleted_at?: string | null;
}

export interface IssueSimilaritySearchResult {
  id: string;
  issue_id: string;
  similarity: number;
}

export interface IssueData {
  markdown: string | null;
  id: string;
  author_id: number;
  payload: Record<string, unknown> | null;
  isPrivate: boolean;
  docType?: IssueDocumentType;
}

export interface IssueWriteOptions {
  deferEmbedding?: boolean;
}

interface FindSimilarIssuesParams {
  markdown: string;
  currentId: string;
  threshold: number;
  topK?: number;
}

function resolveIssueDocType(payload: IssueData["payload"], explicitType?: IssueDocumentType): IssueDocumentType {
  if (explicitType) {
    return explicitType;
  }
  if (payload && typeof payload === "object") {
    const hasIssue = "issue" in payload;
    const hasPullRequest = "pull_request" in payload;
    if (hasPullRequest && !hasIssue) {
      return "pull_request";
    }
  }
  return "issue";
}

export class Issue extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }

  async createIssue(issueData: IssueData, options: IssueWriteOptions = {}) {
    const { isPrivate } = issueData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = resolveIssueDocType(issueData.payload, issueData.docType);
    const cleanedMarkdown = cleanMarkdown(issueData.markdown);
    const isShortIssue = isTooShort(cleanedMarkdown, MIN_ISSUE_MARKDOWN_LENGTH);
    const embeddingSource = !isShortIssue ? cleanedMarkdown : null;
    //First Check if the issue already exists
    const { data: existingData, error: existingError } = await this.supabase
      .from("documents")
      .select("*")
      .eq("id", issueData.id)
      .in("doc_type", ISSUE_DOCUMENT_TYPES);
    if (existingError) {
      this.context.logger.error("Error creating issue", {
        Error: existingError,
        issueData,
      });
      return;
    }
    if (existingData && existingData.length > 0) {
      this.context.logger.warn("Issue already exists", {
        issueData: issueData,
      });
      return;
    }

    //Create the embedding for this issue
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    }
    let nomicEmbedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate && Boolean(this.context.env.NOMIC_API_KEY)) {
      try {
        nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource, "search_document");
      } catch (error) {
        this.context.logger.warn("Failed to generate Nomic embedding for issue, continuing with Voyage", { err: String(error) });
      }
    }
    let finalMarkdown = isShortIssue ? null : issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const { data, error } = await this.supabase.from("documents").insert([
      {
        id: issueData.id,
        doc_type: docType,
        parent_id: null,
        embedding: serializeEmbeddingForDatabase(embedding),
        payload: finalPayload,
        author_id: issueData.author_id,
        markdown: finalMarkdown,
        ...(nomicEmbedding ? { nomic_embedding: serializeEmbeddingForDatabase(nomicEmbedding) } : {}),
      },
    ]);
    if (error) {
      this.context.logger.error("Failed to create issue in database", {
        Error: error,
        issueData,
      });
      return;
    }
    this.context.logger.ok(`Issue created successfully with id: ${issueData.id}`, { data });
  }

  async updateIssue(issueData: IssueData, options: IssueWriteOptions = {}) {
    const { isPrivate } = issueData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = resolveIssueDocType(issueData.payload, issueData.docType);
    const cleanedMarkdown = cleanMarkdown(issueData.markdown);
    const isShortIssue = isTooShort(cleanedMarkdown, MIN_ISSUE_MARKDOWN_LENGTH);
    const embeddingSource = !isShortIssue ? cleanedMarkdown : null;
    //Create the embedding for this issue
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    }
    let nomicEmbedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate && Boolean(this.context.env.NOMIC_API_KEY)) {
      try {
        nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource, "search_document");
      } catch (error) {
        this.context.logger.warn("Failed to generate Nomic embedding for issue, continuing with Voyage", { err: String(error) });
      }
    }
    let finalMarkdown = isShortIssue ? null : issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const issues = await this.getIssue(issueData.id);
    if (!issues || issues.length === 0) {
      this.context.logger.debug("Issue does not exist, creating a new one");
      await this.createIssue({ ...issueData, markdown: finalMarkdown, payload: finalPayload, isPrivate }, { deferEmbedding: shouldDeferEmbedding });
      return;
    }

    const { error } = await this.supabase
      .from("documents")
      .update({
        doc_type: docType,
        markdown: finalMarkdown,
        embedding: serializeEmbeddingForDatabase(embedding),
        payload: finalPayload,
        modified_at: new Date(),
        ...(nomicEmbedding ? { nomic_embedding: serializeEmbeddingForDatabase(nomicEmbedding) } : {}),
      })
      .eq("id", issueData.id)
      .in("doc_type", ISSUE_DOCUMENT_TYPES);

    if (error) {
      this.context.logger.error("Error updating issue", {
        Error: error,
        issueData: {
          id: issueData.id,
          markdown: finalMarkdown,
          embedding,
          payload: finalPayload,
          modified_at: new Date(),
        },
      });
      return;
    }

    this.context.logger.ok("Issue updated successfully with id: " + issueData.id, {
      issueData: {
        id: issueData.id,
        markdown: finalMarkdown,
        embedding,
        payload: finalPayload,
        modified_at: new Date(),
      },
    });
  }

  async getIssue(issueNodeId: string): Promise<IssueType[] | null> {
    const { data, error } = await this.supabase.from("documents").select("*").eq("id", issueNodeId).in("doc_type", ISSUE_DOCUMENT_TYPES).is("deleted_at", null);
    if (error) {
      this.context.logger.error("Error getting issue", {
        Error: error,
        issueData: {
          id: issueNodeId,
        },
      });
      return null;
    }
    return data;
  }

  async deleteIssue(issueNodeId: string) {
    const { error } = await this.supabase
      .from("documents")
      .update({ deleted_at: new Date().toISOString(), modified_at: new Date().toISOString() })
      .eq("id", issueNodeId)
      .in("doc_type", ISSUE_DOCUMENT_TYPES);
    if (error) {
      this.context.logger.error("Error deleting issue", { err: error });
      return;
    }
    this.context.logger.ok("Issue deleted successfully with id: " + issueNodeId);
  }

  async findSimilarIssues({ markdown, currentId, threshold }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.debug("Skipping issue similarity search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_ISSUE_MARKDOWN_LENGTH)) {
        this.context.logger.debug("Skipping issue similarity search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_ISSUE_MARKDOWN_LENGTH,
        });
        return null;
      }
      const shouldUseNomic = this.context.config.embeddingModel === "nomic" && Boolean(this.context.env.NOMIC_API_KEY);

      if (shouldUseNomic) {
        try {
          const nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource, "search_query");
          const { data, error } = await this.supabase.rpc("find_similar_issues_annotate_nomic", {
            query_embedding: nomicEmbedding,
            current_id: currentId,
            threshold,
            top_k: 5,
          });
          if (error) {
            this.context.logger.error("Unable to find similar issues using Nomic", { Error: error, currentId, threshold });
            return null;
          }
          return data;
        } catch (nomicError) {
          this.context.logger.warn("Nomic similarity search failed, falling back to Voyage", { err: String(nomicError) });
        }
      }

      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
      const { data, error } = await this.supabase.rpc("find_similar_issues_annotate", {
        query_embedding: embedding,
        current_id: currentId,
        threshold,
        top_k: 5,
      });
      if (error) {
        this.context.logger.error("Unable to find similar issues", {
          Error: error,
          markdown,
          currentId,
          threshold,
          query_embedding: embedding,
        });
        return null;
      }
      return data;
    } catch (error) {
      this.context.logger.error("Unable to find similar issues", {
        Error: error,
        markdown,
        currentId,
        threshold,
      });
      return null;
    }
  }

  async findSimilarIssuesToMatch({ markdown, currentId, threshold, topK }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.debug("Skipping issue match search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_ISSUE_MARKDOWN_LENGTH)) {
        this.context.logger.debug("Skipping issue match search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_ISSUE_MARKDOWN_LENGTH,
        });
        return null;
      }
      const shouldUseNomic = this.context.config.embeddingModel === "nomic" && Boolean(this.context.env.NOMIC_API_KEY);

      if (shouldUseNomic) {
        try {
          const nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource, "search_query");
          const { data, error } = await this.supabase.rpc("find_similar_issues_to_match_nomic", {
            current_id: currentId,
            query_embedding: nomicEmbedding,
            threshold,
            top_k: topK ?? 5,
          });
          if (error) {
            this.context.logger.error("Error finding similar issues using Nomic", { Error: error, currentId, threshold });
            return null;
          }
          return data;
        } catch (nomicError) {
          this.context.logger.warn("Nomic match search failed, falling back to Voyage", { err: String(nomicError) });
        }
      }

      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
      const { data, error } = await this.supabase.rpc("find_similar_issues_to_match", {
        current_id: currentId,
        query_embedding: embedding,
        threshold,
        top_k: topK ?? 5,
      });
      if (error) {
        this.context.logger.error("Error finding similar issues", {
          Error: error,
          markdown,
          threshold,
          query_embedding: embedding,
        });
        return null;
      }
      return data;
    } catch (error) {
      this.context.logger.error("Error finding similar issues", {
        Error: error,
        markdown,
        threshold,
      });
      return null;
    }
  }
}
