import { Context } from "../types/index";
import { Comment } from "../types/comment";
import { processSimilarIssues, IssueGraphqlResponse, findMostSimilarSentence } from "./issue-deduplication";
import { CommentSimilaritySearchResult } from "../adapters/supabase/helpers/comment";
import { stripHtmlComments } from "../utils/markdown-comments";
import { appendFootnoteRefsToFirstLine, insertFootnoteRefNearSentence } from "../utils/footnote-placement";

interface CommentGraphqlResponse {
  node: {
    body: string;
    url: string;
    issue: {
      number: string;
      repository: {
        name: string;
        owner: {
          login: string;
        };
      };
    };
  };
  similarity: string;
  mostSimilarSentence: { sentence: string; similarity: number; index: number };
}

export async function annotate(context: Context<"issue_comment.created">, commentId: string | null, scope: string) {
  const { logger, octokit, payload } = context;

  const repository = payload.repository;

  if (!commentId) {
    const response = await octokit.rest.issues.listComments({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      per_page: 100,
    });
    const comments = response.data;
    if (comments.length > 1) {
      const commentBeforeAnnotate = comments[comments.length - 2];
      await commentChecker(context, commentBeforeAnnotate, scope);
    } else {
      logger.error("No comments before the annotate command");
    }
  } else {
    const { data } = await octokit.rest.issues.getComment({
      owner: repository.owner.login,
      repo: repository.name,
      comment_id: parseInt(commentId, 10),
    });
    await commentChecker(context, data, scope);
  }
}

/**
 * Checks if the comment is similar to a existing issue or comment.
 * If a similar issue or comment is found, a footnote is added to the comment.
 * @param context The context object
 * @param comment The comment object
 * @param scope The scope of the annotation
 **/
export async function commentChecker(context: Context<"issue_comment.created">, comment: Comment, scope: string) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  let commentBody = comment.body;
  if (!commentBody) {
    logger.info("Comment body is empty", { commentBody });
    return;
  }
  commentBody = removeAnnotateFootnotes(commentBody);
  const commentBodyForMatching = stripHtmlComments(commentBody);
  const similarIssues = await supabase.issue.findSimilarIssues({
    markdown: commentBodyForMatching,
    currentId: comment.node_id,
    threshold: context.config.annotateThreshold,
  });
  const similarComments = await supabase.comment.findSimilarComments({
    markdown: commentBodyForMatching,
    currentId: comment.node_id,
    threshold: context.config.annotateThreshold,
  });
  let processedIssues: IssueGraphqlResponse[] = [];
  let processedComments: CommentGraphqlResponse[] = [];
  if (similarIssues && similarIssues.length > 0) {
    processedIssues = await processSimilarIssues(similarIssues, context, commentBodyForMatching);
    processedIssues = processedIssues.filter((issue) =>
      filterByScope(scope, payload.repository.owner.login, issue.node.repository.owner.login, payload.repository.name, issue.node.repository.name)
    );
    if (processedIssues.length > 0) {
      logger.info(`Similar issue which matches more than ${context.config.annotateThreshold} already exists`, { processedIssues });
    } else {
      context.logger.info("No similar issues found for comment", { commentBody });
    }
  } else {
    context.logger.info("No similar issues found for comment", { commentBody });
  }
  if (similarComments && similarComments.length > 0) {
    processedComments = await processSimilarComments(similarComments, context, commentBodyForMatching);
    processedComments = processedComments.filter((comment) =>
      filterByScope(
        scope,
        payload.repository.owner.login,
        comment.node.issue.repository.owner.login,
        payload.repository.name,
        comment.node.issue.repository.name
      )
    );
    if (processedComments.length > 0) {
      logger.info(`Similar comment which matches more than ${context.config.annotateThreshold} already exists`, { processedComments });
    } else {
      context.logger.info("No similar comments found for comment", { commentBody });
    }
  } else {
    context.logger.info("No similar comments found for comment", { commentBody });
  }
  await handleSimilarIssuesAndComments(context, payload, commentBody, comment.id, processedIssues, processedComments);
}

function filterByScope(scope: string, repoOrg: string, similarIssueRepoOrg: string, repoName: string, similarIssueRepoName: string): boolean {
  switch (scope) {
    case "global":
      return true;
    case "org":
      return repoOrg === similarIssueRepoOrg;
    case "repo":
      return repoOrg === similarIssueRepoOrg && repoName === similarIssueRepoName;
    default:
      return false;
  }
}

async function handleSimilarIssuesAndComments(
  context: Context,
  payload: Context["payload"],
  commentBody: string,
  commentId: number,
  issueList: IssueGraphqlResponse[],
  commentList: CommentGraphqlResponse[]
) {
  if (!issueList.length && !commentList.length) {
    return;
  }
  // Find existing footnotes in the body
  const footnoteRegex = /\[\^(\d+)\^\]/g;
  const existingFootnotes = commentBody.match(footnoteRegex) || [];
  let highestFootnoteIndex = existingFootnotes.length > 0 ? Math.max(...existingFootnotes.map((fn) => parseInt(fn.match(/\d+/)?.[0] ?? "0"))) : 0;
  let updatedBody = commentBody;
  const footnotes: string[] = [];
  const orphanRefs: string[] = [];
  // Sort relevant issues by similarity in ascending order
  issueList.sort((a, b) => parseFloat(a.similarity) - parseFloat(b.similarity));
  issueList.forEach((issue, index) => {
    const footnoteIndex = highestFootnoteIndex + index + 1; // Continue numbering from the highest existing footnote number
    const footnoteRef = `[^0${footnoteIndex}^]`;
    const modifiedUrl = issue.node.url.replace("https://github.com", "https://www.github.com");
    const { sentence } = issue.mostSimilarSentence;
    // Insert footnote reference in the body
    if (!sentence.trim()) {
      orphanRefs.push(footnoteRef);
    } else {
      const sentencePattern = new RegExp(`${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
      const beforeReplace = updatedBody;
      updatedBody = updatedBody.replace(sentencePattern, (match) => {
        // Check if the sentence is preceded by triple backticks to avoid breaking the code block section
        const isAfterCodeBlock = /```\s*$/.test(match);
        return `${match}${isAfterCodeBlock ? "\n" : " "}${footnoteRef}`;
      });
      if (beforeReplace === updatedBody) {
        const fallback = insertFootnoteRefNearSentence(updatedBody, sentence, footnoteRef);
        updatedBody = fallback.updated;
        if (!fallback.inserted) {
          orphanRefs.push(footnoteRef);
        }
      }
    }

    // Add new footnote to the array
    footnotes.push(`${footnoteRef}: ${issue.similarity}% similar to issue: [${issue.node.title}](${modifiedUrl})\n\n`);
  });
  highestFootnoteIndex += footnotes.length;
  commentList.sort((a, b) => parseFloat(a.similarity) - parseFloat(b.similarity));
  commentList.forEach((comment, index) => {
    const footnoteIndex = highestFootnoteIndex + index + 1; // Continue numbering from the highest existing footnote number
    const footnoteRef = `[^0${footnoteIndex}^]`;
    const modifiedUrl = comment.node.url.replace("https://github.com", "https://www.github.com");
    const { sentence } = comment.mostSimilarSentence;
    // Insert footnote reference in the body
    if (!sentence.trim()) {
      orphanRefs.push(footnoteRef);
    } else {
      const sentencePattern = new RegExp(`${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
      const beforeReplace = updatedBody;
      updatedBody = updatedBody.replace(sentencePattern, (match) => {
        // Check if the sentence is preceded by triple backticks to avoid breaking the code block section
        const isAfterCodeBlock = /```\s*$/.test(match);
        return `${match}${isAfterCodeBlock ? "\n" : " "}${footnoteRef}`;
      });
      if (beforeReplace === updatedBody) {
        const fallback = insertFootnoteRefNearSentence(updatedBody, sentence, footnoteRef);
        updatedBody = fallback.updated;
        if (!fallback.inserted) {
          orphanRefs.push(footnoteRef);
        }
      }
    }

    // Add new footnote to the array
    footnotes.push(`${footnoteRef}: ${comment.similarity}% similar to comment: [#${comment.node.issue.number} (comment)](${modifiedUrl})\n\n`);
  });
  if (orphanRefs.length > 0) {
    updatedBody = appendFootnoteRefsToFirstLine(updatedBody, orphanRefs);
  }
  // Append new footnotes to the body, keeping the previous ones
  if (footnotes.length > 0) {
    updatedBody += "\n\n" + footnotes.join("");
  }
  // Update the comment with the modified body
  await context.octokit.rest.issues.updateComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    comment_id: commentId,
    body: updatedBody,
  });
}

// Process similar comments and return the list of similar comments with their similarity scores
async function processSimilarComments(
  similarComments: CommentSimilaritySearchResult[],
  context: Context,
  commentBody: string
): Promise<CommentGraphqlResponse[]> {
  const processedComments = await Promise.all(
    similarComments.map(async (comment: CommentSimilaritySearchResult) => {
      try {
        const commentUrl: CommentGraphqlResponse = await context.octokit.graphql(
          /* GraphQL */
          `
            query ($commentNodeId: ID!) {
              node(id: $commentNodeId) {
                ... on IssueComment {
                  body
                  url
                  issue {
                    number
                    repository {
                      name
                      owner {
                        login
                      }
                    }
                  }
                }
              }
            }
          `,
          { commentNodeId: comment.comment_id }
        );
        commentUrl.similarity = Math.round(comment.similarity * 100).toString();
        const similarBody = stripHtmlComments(commentUrl.node.body);
        commentUrl.mostSimilarSentence = findMostSimilarSentence(commentBody, similarBody, context);
        return commentUrl;
      } catch (error) {
        context.logger.error(`Failed to fetch comment ${comment.comment_id}: ${error}`, { comment });
        return null;
      }
    })
  );
  return processedComments.filter((comment): comment is CommentGraphqlResponse => comment !== null);
}

/**
 * Checks if a annotate footnote exists in the content.
 * @param content The content to check for annotate footnotes
 * @returns True if a annotate footnote exists, false otherwise
 */
export function checkIfAnnotateFootNoteExists(content: string): boolean {
  const footnoteDefRegex = /\[\^(\d+)\^\]: \d+% similar to (issue|comment): [^\n]+(\n|$)/g;
  const footnotes = content.match(footnoteDefRegex);
  return !!footnotes;
}

/**
 * Removes annotate footnotes from the comment content.
 * This includes both the footnote references in the body and the footnote definitions at the bottom.
 * @param content The content of the comment
 * @returns The content without footnotes
 */
export function removeAnnotateFootnotes(content: string): string {
  const footnoteDefRegex = /\[\^(\d+)\^\]: \d+% similar to (issue|comment): [^\n]+(\n|$)/g;
  const footnotes = content.match(footnoteDefRegex);
  let contentWithoutFootnotes = content.replace(footnoteDefRegex, "");
  if (footnotes) {
    footnotes.forEach((footnote) => {
      const footnoteNumber = footnote.match(/\d+/)?.[0];
      contentWithoutFootnotes = contentWithoutFootnotes.replace(new RegExp(`\\[\\^${footnoteNumber}\\^\\]`, "g"), "");
    });
  }
  return contentWithoutFootnotes;
}
