import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { COMMENT_DOCUMENT_TYPES, CommentDocumentType } from "../../../types/document";
import { serializeEmbeddingForDatabase } from "../../../utils/database-embedding";
import { cleanMarkdown, isTooShort, MIN_COMMENT_MARKDOWN_LENGTH } from "../../../utils/embedding-content";
import { isCommandLikeContent } from "../../../utils/markdown-comments";

export interface CommentType {
  id: string;
  doc_type?: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[] | null;
  deleted_at?: string | null;
}

export interface CommentData {
  markdown: string | null;
  id: string;
  author_id: number;
  payload: Record<string, unknown> | null;
  isPrivate: boolean;
  issue_id: string | null;
  docType?: CommentDocumentType;
}

export interface CommentWriteOptions {
  deferEmbedding?: boolean;
}

export interface CommentSimilaritySearchResult {
  comment_id: string;
  similarity: number;
}

interface FindSimilarCommentsParams {
  markdown: string;
  currentId: string;
  threshold: number;
}

export class Comment extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }

  async createComment(commentData: CommentData, options: CommentWriteOptions = {}) {
    const { isPrivate } = commentData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = commentData.docType ?? "issue_comment";
    const cleanedMarkdown = cleanMarkdown(commentData.markdown);
    const isCommandComment = cleanedMarkdown ? isCommandLikeContent(cleanedMarkdown) : false;
    const isShortComment = isTooShort(cleanedMarkdown, MIN_COMMENT_MARKDOWN_LENGTH);
    const shouldSkipEmbedding = isCommandComment || isShortComment;
    const embeddingSource = shouldSkipEmbedding ? null : cleanedMarkdown;
    //First Check if the comment already exists
    const { data: existingData, error: existingError } = await this.supabase
      .from("documents")
      .select("*")
      .eq("id", commentData.id)
      .in("doc_type", COMMENT_DOCUMENT_TYPES);
    if (existingError) {
      this.context.logger.error("Error creating comment", {
        Error: existingError,
        commentData,
      });
      return;
    }
    if (existingData && existingData.length > 0) {
      this.context.logger.warn("Comment already exists", {
        commentData: commentData,
      });
      return;
    }
    //Create the embedding for this comment
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    }
    let nomicEmbedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate && Boolean(this.context.env.NOMIC_API_KEY)) {
      try {
        nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource, "search_document");
      } catch (error) {
        this.context.logger.warn("Failed to generate Nomic embedding for comment, continuing with Voyage", { err: String(error) });
      }
    }
    let finalMarkdown = shouldSkipEmbedding ? null : commentData.markdown;
    let finalPayload = commentData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }
    const { data, error } = await this.supabase.from("documents").insert([
      {
        id: commentData.id,
        doc_type: docType,
        parent_id: commentData.issue_id,
        markdown: finalMarkdown,
        author_id: commentData.author_id,
        embedding: serializeEmbeddingForDatabase(embedding),
        payload: finalPayload,
        ...(nomicEmbedding ? { nomic_embedding: serializeEmbeddingForDatabase(nomicEmbedding) } : {}),
      },
    ]);
    if (error) {
      this.context.logger.error("Failed to create comment in database", {
        Error: error,
        commentData,
      });
      return;
    }
    this.context.logger.ok(`Comment created successfully with id: ${commentData.id}`, { data });
  }

  async updateComment(commentData: CommentData, options: CommentWriteOptions = {}) {
    const { isPrivate } = commentData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = commentData.docType ?? "issue_comment";
    const cleanedMarkdown = cleanMarkdown(commentData.markdown);
    const isCommandComment = cleanedMarkdown ? isCommandLikeContent(cleanedMarkdown) : false;
    const isShortComment = isTooShort(cleanedMarkdown, MIN_COMMENT_MARKDOWN_LENGTH);
    const shouldSkipEmbedding = isCommandComment || isShortComment;
    const embeddingSource = shouldSkipEmbedding ? null : cleanedMarkdown;
    //Create the embedding for this comment
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    }
    let nomicEmbedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate && Boolean(this.context.env.NOMIC_API_KEY)) {
      try {
        nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource, "search_document");
      } catch (error) {
        this.context.logger.warn("Failed to generate Nomic embedding for comment, continuing with Voyage", { err: String(error) });
      }
    }
    let finalMarkdown = shouldSkipEmbedding ? null : commentData.markdown;
    let finalPayload = commentData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }
    const comments = await this.getComment(commentData.id);
    if (comments && comments.length == 0) {
      this.context.logger.debug("Comment does not exist, creating a new one");
      await this.createComment({ ...commentData, markdown: finalMarkdown, payload: finalPayload, isPrivate }, { deferEmbedding: shouldDeferEmbedding });
    } else {
      const { error } = await this.supabase
        .from("documents")
        .update({
          doc_type: docType,
          parent_id: commentData.issue_id,
          markdown: finalMarkdown,
          embedding: serializeEmbeddingForDatabase(embedding),
          payload: finalPayload,
          modified_at: new Date(),
          ...(nomicEmbedding ? { nomic_embedding: serializeEmbeddingForDatabase(nomicEmbedding) } : {}),
        })
        .eq("id", commentData.id)
        .in("doc_type", COMMENT_DOCUMENT_TYPES);
      if (error) {
        this.context.logger.error("Error updating comment", {
          Error: error,
          commentData: {
            commentData,
            markdown: finalMarkdown,
            embedding,
            payload: finalPayload,
            modified_at: new Date(),
          },
        });
        return;
      }
      this.context.logger.ok("Comment updated successfully with id: " + commentData.id, {
        commentData: {
          commentData,
          markdown: finalMarkdown,
          embedding,
          payload: finalPayload,
          modified_at: new Date(),
        },
      });
    }
  }

  async getComment(commentNodeId: string): Promise<CommentType[] | null> {
    const { data, error } = await this.supabase
      .from("documents")
      .select("*")
      .eq("id", commentNodeId)
      .in("doc_type", COMMENT_DOCUMENT_TYPES)
      .is("deleted_at", null);
    if (error) {
      this.context.logger.error("Error getting comment", {
        Error: error,
        commentData: {
          id: commentNodeId,
        },
      });
      return null;
    }
    return data;
  }

  async deleteComment(commentNodeId: string) {
    const { error } = await this.supabase
      .from("documents")
      .update({ deleted_at: new Date().toISOString(), modified_at: new Date().toISOString() })
      .eq("id", commentNodeId)
      .in("doc_type", COMMENT_DOCUMENT_TYPES);
    if (error) {
      this.context.logger.error("Error deleting comment", {
        Error: error,
        commentData: {
          id: commentNodeId,
        },
      });
      return;
    }
    this.context.logger.ok("Comment deleted successfully with id: " + commentNodeId);
  }

  async findSimilarComments({ markdown, currentId, threshold }: FindSimilarCommentsParams): Promise<CommentSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.debug("Skipping comment similarity search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_COMMENT_MARKDOWN_LENGTH)) {
        this.context.logger.debug("Skipping comment similarity search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_COMMENT_MARKDOWN_LENGTH,
        });
        return null;
      }
      const shouldUseNomic = this.context.config.embeddingModel === "nomic" && Boolean(this.context.env.NOMIC_API_KEY);

      if (shouldUseNomic) {
        try {
          const nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource, "search_query");
          const { data, error } = await this.supabase.rpc("find_similar_comments_annotate_nomic", {
            current_id: currentId,
            query_embedding: nomicEmbedding,
            threshold,
            top_k: 5,
          });
          if (error) {
            this.context.logger.error("Unable to find similar comments using Nomic", { Error: error, currentId, threshold });
            return null;
          }
          return data;
        } catch (nomicError) {
          this.context.logger.warn("Nomic comment search failed, falling back to Voyage", { err: String(nomicError) });
        }
      }

      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
      const { data, error } = await this.supabase.rpc("find_similar_comments_annotate", {
        query_embedding: embedding,
        current_id: currentId,
        threshold,
        top_k: 5,
      });
      if (error) {
        this.context.logger.error("Unable to find similar comments", {
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
      this.context.logger.error("Unable to find similar comments", {
        Error: error,
        markdown,
        currentId,
        threshold,
      });
      return null;
    }
  }
}
