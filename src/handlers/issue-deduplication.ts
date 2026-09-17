import he from "he";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { IssueSimilaritySearchResult } from "../adapters/supabase/helpers/issues";
import { Context } from "../types/index";
import { appendPluginUpdateComment, normalizeWhitespace, stripHtmlComments, stripPluginUpdateComments } from "../utils/markdown-comments";
import { appendFootnoteRefsToFirstLine, insertFootnoteRefNearSentence } from "../utils/footnote-placement";
import { stripDuplicateFootnotes } from "../utils/footnotes";
import { findEditDistance } from "../utils/string-similarity";

export interface IssueGraphqlResponse {
  node: {
    title: string;
    number: number;
    url: string;
    body: string;
    repository: {
      name: string;
      owner: {
        login: string;
      };
    };
  };
  similarity: string;
  mostSimilarSentence: { sentence: string; similarity: number; index: number };
}

/**
 * Checks if the current issue is a duplicate of an existing issue.
 * If a similar issue is found, a footnote is added to the current issue.
 * @param context The context object
 **/
export async function issueDedupe(context: Context<"issues.opened" | "issues.edited">, options: { keepUpdateComment?: boolean } = {}) {
  const {
    logger,
    adapters: { supabase },
    octokit,
    payload,
  } = context;
  const shouldKeepUpdateComment = options.keepUpdateComment ?? false;

  const originalIssue = payload.issue;
  const authorType = originalIssue.user?.type;
  const isHumanAuthor = authorType === "User";
  if (!isHumanAuthor) {
    logger.debug("Skipping dedupe for non-human author.", {
      author: originalIssue.user?.login,
      type: authorType,
      issue: originalIssue.number,
    });
    return;
  }

  // Use the latest issue data
  const issueBody = originalIssue.body;
  if (!issueBody) {
    logger.info("Issue body is empty", { originalIssue });
    return;
  }
  const { cleaned: bodyWithoutPluginUpdates, latestComment } = stripPluginUpdateComments(issueBody);
  const updateComment = shouldKeepUpdateComment ? latestComment : null;
  const cleanedIssueBody = await cleanContent(context, bodyWithoutPluginUpdates);
  const issueBodyForMatching = stripHtmlComments(cleanedIssueBody);
  const similarIssues = await supabase.issue.findSimilarIssues({
    markdown: originalIssue.title + issueBodyForMatching,
    currentId: originalIssue.node_id,
    threshold: context.config.dedupeWarningThreshold,
  });
  if (similarIssues && similarIssues.length > 0) {
    let processedIssues = await processSimilarIssues(similarIssues, context, issueBodyForMatching);
    processedIssues = processedIssues.filter((issue) =>
      matchRepoOrgToSimilarIssueRepoOrg(payload.repository.owner.login, issue.node.repository.owner.login, payload.repository.name, issue.node.repository.name)
    );
    const matchIssues = processedIssues.filter((issue) => parseFloat(issue.similarity) / 100 >= context.config.dedupeMatchThreshold);
    if (matchIssues.length > 0) {
      logger.info(`Similar issue which matches more than ${context.config.dedupeMatchThreshold} already exists`, { matchIssues });
      //To the issue body, add a footnote with the link to the similar issue
      const updatedBody = await handleMatchIssuesComment(context, payload, cleanedIssueBody, processedIssues);
      const outputBody = updatedBody || cleanedIssueBody;
      const nextBody = updateComment ? appendPluginUpdateComment(outputBody, updateComment) : outputBody;
      const isBodyUnchanged = normalizeWhitespace(originalIssue.body ?? "") === normalizeWhitespace(nextBody);
      const shouldClose = originalIssue.state !== "closed" || originalIssue.state_reason !== "not_planned";
      if (isBodyUnchanged && !shouldClose) {
        logger.info("Issue body unchanged after dedupe match update", { issueNumber: originalIssue.number });
        return;
      }
      await octokit.rest.issues.update({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: originalIssue.number,
        body: nextBody,
        state: "closed",
        state_reason: "not_planned",
      });
      return;
    }
    if (processedIssues.length > 0) {
      logger.info(`Similar issue which matches more than ${context.config.dedupeWarningThreshold} already exists`, { processedIssues });
      await handleSimilarIssuesComment(context, payload, cleanedIssueBody, originalIssue.body ?? "", originalIssue.number, processedIssues, updateComment);
      return;
    }
  } else {
    //Use the IssueBody (Without footnotes) to update the issue when no similar issues are found
    //Only if the issue has "possible duplicate" footnotes, update the issue
    if (checkIfDuplicateFootNoteExists(cleanedIssueBody || "")) {
      const outputBody = updateComment ? appendPluginUpdateComment(cleanedIssueBody, updateComment) : cleanedIssueBody;
      if (normalizeWhitespace(originalIssue.body ?? "") === normalizeWhitespace(outputBody)) {
        logger.info("Issue body unchanged after duplicate footnote cleanup", { issueNumber: originalIssue.number });
        return;
      }
      await octokit.rest.issues.update({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: originalIssue.number,
        body: outputBody,
      });
    }
  }
  context.logger.info("No similar issues found");
}

function matchRepoOrgToSimilarIssueRepoOrg(repoOrg: string, similarIssueRepoOrg: string, repoName: string, similarIssueRepoName: string): boolean {
  return repoOrg === similarIssueRepoOrg && repoName === similarIssueRepoName;
}

function splitIntoSentences(text: string): string[] {
  const sentenceRegex = /([^.!?\s][^.!?]*(?:[.!?](?!['"]?\s|$)[^.!?]*)*[.!?]?['"]?(?=\s|$))/g;
  const sentences: string[] = [];
  let match;
  while ((match = sentenceRegex.exec(text)) !== null) {
    sentences.push(match[0].trim());
  }
  return sentences;
}

/**
 * Finds the most similar sentence in a similar issue to a sentence in the current issue.
 * @param issueContent The content of the current issue
 * @param similarIssueContent The content of the similar issue
 * @returns The most similar sentence and its similarity score
 */
export function findMostSimilarSentence(
  issueContent: string,
  similarIssueContent: string,
  context: Context
): { sentence: string; similarity: number; index: number } {
  const issueSentences = splitIntoSentences(issueContent);
  const similarIssueSentences = splitIntoSentences(similarIssueContent);

  let maxSimilarity = 0;
  let mostSimilarSentence = "";
  let mostSimilarIndex = -1;

  issueSentences.forEach((sentence, index) => {
    const similarities = similarIssueSentences.map((similarSentence) => {
      const editDistance = findEditDistance(sentence, similarSentence);
      const maxLength = Math.max(sentence.length, similarSentence.length);
      // Normalized similarity (edit distance)
      return 1 - editDistance / maxLength;
    });
    const maxSentenceSimilarity = Math.max(...similarities);
    if (maxSentenceSimilarity > maxSimilarity) {
      maxSimilarity = maxSentenceSimilarity;
      mostSimilarSentence = sentence;
      mostSimilarIndex = index;
    }
  });

  if (!mostSimilarSentence) {
    context.logger.error("No similar sentence found");
  }
  return { sentence: mostSimilarSentence, similarity: maxSimilarity, index: mostSimilarIndex };
}

async function handleSimilarIssuesComment(
  context: Context,
  payload: Context<"issues.opened" | "issues.edited">["payload"],
  issueBody: string,
  currentBody: string,
  issueNumber: number,
  issueList: IssueGraphqlResponse[],
  latestComment: string | null
) {
  const relevantIssues = issueList.filter((issue) =>
    matchRepoOrgToSimilarIssueRepoOrg(payload.repository.owner.login, issue.node.repository.owner.login, payload.repository.name, issue.node.repository.name)
  );

  if (relevantIssues.length === 0) {
    context.logger.info("No relevant issues found with the same repository and organization");
    return;
  }

  if (!issueBody) {
    return;
  }
  // Find existing footnotes in the body
  const footnoteRegex = /\[\^(\d+)\^\]/g;
  const existingFootnotes = issueBody.match(footnoteRegex) || [];
  const highestFootnoteIndex = existingFootnotes.length > 0 ? Math.max(...existingFootnotes.map((fn) => parseInt(fn.match(/\d+/)?.[0] ?? "0"))) : 0;
  let updatedBody = issueBody;
  const footnotes: string[] = [];
  const orphanRefs: string[] = [];
  // Sort relevant issues by similarity in ascending order
  relevantIssues.sort((a, b) => parseFloat(a.similarity) - parseFloat(b.similarity));
  relevantIssues.forEach((issue, index) => {
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
    footnotes.push(`${footnoteRef}: ⚠ ${issue.similarity}% possible duplicate - [${issue.node.title}](${modifiedUrl})\n\n`);
  });
  if (orphanRefs.length > 0) {
    updatedBody = appendFootnoteRefsToFirstLine(updatedBody, orphanRefs);
  }
  // Append new footnotes to the body, keeping the previous ones
  if (footnotes.length > 0) {
    updatedBody += "\n\n" + footnotes.join("");
  }
  // Update the issue with the modified body
  const outputBody = latestComment ? appendPluginUpdateComment(updatedBody, latestComment) : updatedBody;
  if (normalizeWhitespace(currentBody) === normalizeWhitespace(outputBody)) {
    context.logger.info("Issue body unchanged after dedupe warning update", { issueNumber });
    return;
  }
  await context.octokit.rest.issues.update({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: issueNumber,
    body: outputBody,
  });
}

//When similarity is greater than match threshold, Add Caution mentioning the issues to which its is very much similar
async function handleMatchIssuesComment(
  context: Context,
  payload: Context<"issues.opened" | "issues.edited">["payload"],
  issueBody: string,
  relevantIssues: IssueGraphqlResponse[]
): Promise<string | undefined> {
  if (!issueBody) {
    return;
  }
  // Find existing footnotes in the body
  const footnoteRegex = /\[\^(\d+)\^\]/g;
  const existingFootnotes = issueBody.match(footnoteRegex) || [];
  // Find the index with respect to the issue body string where the footnotes start if they exist
  const footnoteIndex = existingFootnotes[0] ? issueBody.indexOf(existingFootnotes[0]) : issueBody.length;
  let resultBuilder = "\n\n>[!CAUTION]\n> This issue may be a duplicate of the following issues:\n";
  // Sort relevant issues by similarity in descending order
  relevantIssues.sort((a, b) => parseFloat(b.similarity) - parseFloat(a.similarity));
  // Append the similar issues to the resultBuilder
  relevantIssues.forEach((issue) => {
    const modifiedUrl = issue.node.url.replace("https://github.com", "https://www.github.com");
    resultBuilder += `> - [${issue.node.title}](${modifiedUrl})\n`;
  });
  // Insert the resultBuilder into the issue body
  // Update the issue with the modified body
  return issueBody.slice(0, footnoteIndex) + resultBuilder + issueBody.slice(footnoteIndex);
}

// Process similar issues and return the list of similar issues with their similarity scores
export async function processSimilarIssues(similarIssues: IssueSimilaritySearchResult[], context: Context, issueBody: string): Promise<IssueGraphqlResponse[]> {
  const processedIssues = await Promise.all(
    similarIssues.map(async (issue: IssueSimilaritySearchResult) => {
      try {
        const issueUrl: IssueGraphqlResponse = await context.octokit.graphql(
          /* GraphQL */
          `
            query ($issueNodeId: ID!) {
              node(id: $issueNodeId) {
                ... on Issue {
                  title
                  url
                  number
                  body
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                }
              }
            }
          `,
          { issueNodeId: issue.issue_id }
        );
        issueUrl.similarity = Math.round(issue.similarity * 100).toString();
        const similarBody = stripHtmlComments(issueUrl.node.body);
        issueUrl.mostSimilarSentence = findMostSimilarSentence(issueBody, similarBody, context);
        return issueUrl;
      } catch (error) {
        context.logger.error(`Failed to fetch issue ${issue.issue_id}: ${error}`, { issue });
        return null;
      }
    })
  );
  return processedIssues.filter((issue): issue is IssueGraphqlResponse => issue !== null);
}

/**
 * Finds the edit distance between two strings using dynamic programming.
 * The edit distance is a way of quantifying how dissimilar two strings are to one another by
 * counting the minimum number of operations required to transform one string into the other.
 * For more information, see: https://en.wikipedia.org/wiki/Edit_distance
 * @param sentenceA The first string
 * @param sentenceB The second string
 * @returns The edit distance between the two strings
 */
// findEditDistance moved to utils/string-similarity

/**
 * Removes all footnotes from the issue content.
 * This includes both the footnote references in the body and the footnote definitions at the bottom.
 * @param content The content of the issue
 * @returns The content without footnotes
 */

async function handleAnchorAndImgElements(context: Context, content: string) {
  const html = await marked(content);
  const jsDom = new JSDOM(html);
  const htmlElement = jsDom.window.document;
  const anchors = htmlElement.getElementsByTagName("a");
  const images = htmlElement.getElementsByTagName("img");

  async function processElement(element: HTMLAnchorElement | HTMLImageElement, isImage: boolean) {
    const url = isImage ? (element as HTMLImageElement).getAttribute("src") : (element as HTMLAnchorElement).getAttribute("href");
    if (!url) return;

    try {
      const linkResponse = await fetch(url);
      if (!linkResponse.ok) {
        context.logger.warn(`Failed to fetch ${url}`, { linkResponse });
        return;
      }
      const contentType = linkResponse.headers.get("content-type");
      if (!contentType?.startsWith("image/")) {
        context.logger.warn(`Content type is not an image: ${contentType}, will skip ${url}`);
        return;
      }

      const altContent = await context.adapters.llm.createCompletion(linkResponse);

      if (!altContent) return;

      const escapedSrc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const imageHtmlRegex = new RegExp(`<img([^>]*?)src="${escapedSrc}"([^>]*?)\\s*/?>`, "g");
      content = content.replace(imageHtmlRegex, (match, beforeSrc, afterSrc) => {
        if (match.includes("alt=")) {
          return match.replace(/alt="[^"]*"/, `alt="${he.encode(altContent)}"`);
        } else {
          return `<img${beforeSrc}alt="${he.encode(altContent)}" src="${url}"${afterSrc} />`;
        }
      });
      const linkRegex = new RegExp(`\\[([^\\]]+)\\]\\(${escapedSrc}\\)`, "g");
      content = content.replace(linkRegex, `[$1](${url} "${he.encode(altContent)}")`);
    } catch (e) {
      context.logger.warn(`Failed to process ${url}`, { e });
    }
  }

  for (const anchor of anchors) {
    await processElement(anchor, false);
  }
  for (const image of images) {
    await processElement(image, true);
  }

  context.logger.debug("Enriched comment content with image descriptions.", { content });
  return content;
}

export async function cleanContent(context: Context, content: string): Promise<string> {
  return stripDuplicateFootnotes(await handleAnchorAndImgElements(context, content));
}

/**
 * Checks if a duplicate footnote exists in the content.
 * @param content The content to check for duplicate footnotes
 * @returns True if a duplicate footnote exists, false otherwise
 */
export function checkIfDuplicateFootNoteExists(content: string): boolean {
  const footnoteDefRegex = /\[\^(\d+)\^\]: ⚠ \d+% possible duplicate - [^\n]+(\n|$)/g;
  const footnotes = content.match(footnoteDefRegex);
  return !!footnotes;
}
