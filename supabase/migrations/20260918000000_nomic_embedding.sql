-- Add Nomic Embed v1.5 column (768 dimensions)
-- Nomic Embed v1.5 offers ~10% improved retrieval accuracy vs Voyage-4-large
-- See: https://github.com/ubiquity-os-marketplace/text-vector-embeddings/issues/111

ALTER TABLE documents ADD COLUMN IF NOT EXISTS nomic_embedding vector(768);

-- Index for Nomic embedding similarity search
CREATE INDEX IF NOT EXISTS documents_nomic_embedding_ivfflat
  ON public.documents USING ivfflat (nomic_embedding vector_cosine_ops)
  WITH (lists = '10');

COMMENT ON COLUMN documents.nomic_embedding IS 'Nomic Embed v1.5 embeddings (768d). Used when embeddingModel setting is "nomic". Provides ~10% higher retrieval accuracy than Voyage-4-large.';

-- Nomic-specific similarity search functions (768d vectors)

CREATE OR REPLACE FUNCTION find_similar_issues_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
DECLARE
    current_repo TEXT;
    current_org TEXT;
BEGIN
    SELECT
        payload->'repository'->>'name'::text,
        payload->'repository'->'owner'->>'login'::text
    INTO current_repo, current_org
    FROM documents
    WHERE id = current_id
      AND doc_type = 'issue';

    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, nomic_embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, nomic_embedding)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND nomic_embedding IS NOT NULL
            AND COALESCE(payload->'repository'->>'name', '') = COALESCE(current_repo, '')
            AND COALESCE(payload->'repository'->'owner'->>'login', '') = COALESCE(current_org, '')
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.8 * (1 - cosine_distance(query_embedding, nomic_embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, nomic_embedding)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND deleted_at IS NULL
            AND nomic_embedding IS NOT NULL
            AND doc_type IN ('issue_comment', 'review_comment', 'pull_request_review')
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_annotate_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.7 * (1 - cosine_distance(query_embedding, nomic_embedding))) + 0.3 * (1 / (1 + l2_distance(query_embedding, nomic_embedding)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND nomic_embedding IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_annotate_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.7 * (1 - cosine_distance(query_embedding, nomic_embedding))) + 0.3 * (1 / (1 + l2_distance(query_embedding, nomic_embedding)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type IN ('issue_comment', 'review_comment', 'pull_request_review')
            AND deleted_at IS NULL
            AND nomic_embedding IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_to_match_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, nomic_embedding))) + 0.2 * (1 / (1 + l2_distance(query_embedding, nomic_embedding)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND nomic_embedding IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;
