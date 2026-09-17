// cSpell:disable

import { drop } from "@mswjs/data";
import { customOctokit as Octokit } from "@ubiquity-os/plugin-sdk/octokit";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import dotenv from "dotenv";
import { IssueSimilaritySearchResult } from "../src/adapters/supabase/helpers/issues";
import { Context } from "../src/types/context";
import { Env } from "../src/types/index";
import { CommentMock, createMockAdapters, IssueMock } from "./__mocks__/adapter";
import { db } from "./__mocks__/db";
import { createComment, createIssue, fetchSimilarIssues, setupTests } from "./__mocks__/helpers";
import { server } from "./__mocks__/node";
import { STRINGS } from "./__mocks__/strings";
import annotateComment from "./__sample__/comment_annotate.json";

// Constants to avoid duplication
const DEFAULT_HOOK = "issue_comment.created";
const DEFAULT_ISSUE_ID = "1";
const DEFAULT_BODY = "Test issue body";
const ISSUES_EDITED_EVENT_NAME = "issues.edited";
const DEFAULT_LAST_EDITED_AT = "2020-01-12T17:52:02Z";

dotenv.config();
const octokit = new Octokit();
let runPlugin: typeof import("../src/plugin").runPlugin;

beforeAll(() => {
  server.listen();
  return import(`../src/plugin?t=${Date.now()}`).then((mod) => {
    runPlugin = mod.runPlugin;
  });
});
afterEach(() => {
  server.resetHandlers();
  mock.restore();
});
afterAll(() => server.close());

describe("Plugin tests", () => {
  beforeEach(async () => {
    drop(db);
    await setupTests();
    await mock.module("../src/helpers/plugin-utils", () => ({
      isPluginEdit: mock(() => true),
    }));
  });

  it("When a comment is created it should add it to the database", async () => {
    const { context } = createContext(STRINGS.HELLO_WORLD, 1, 1, 1, "sasasCreate");

    // Run the plugin which should create the comment
    await runPlugin(context);

    // Verify the comment was created
    const comment = (await context.adapters.supabase.comment.getComment("sasasCreate")) as unknown as CommentMock;
    expect(comment).toBeDefined();
    expect(comment?.embedding).toBeDefined();

    // Try to create the same comment again
    const commentObject = null;
    expect(
      context.adapters.supabase.comment.createComment({
        markdown: STRINGS.HELLO_WORLD,
        id: "sasasCreate",
        author_id: 1,
        payload: commentObject,
        isPrivate: false,
        issue_id: "sasasCreateIssue",
      })
    ).rejects.toThrow("Comment already exists");
  });

  it("When a comment is updated it should update the database", async () => {
    const updateId = "sasasUpdate";
    const { context } = createContext(STRINGS.HELLO_WORLD, 1, 1, 1, updateId, "1", DEFAULT_HOOK);
    const supabase = context.adapters.supabase;

    // Create the issue first
    await supabase.issue.createIssue({
      markdown: "Test Body",
      id: "1",
      author_id: 1,
      payload: null,
      isPrivate: false,
    });

    // Create initial comment
    await runPlugin(context);

    // Update the comment
    const updateContext = createContext("Updated Message", 1, 1, 1, updateId, "1", "issue_comment.edited");
    updateContext.context.adapters.supabase = supabase;
    await runPlugin(updateContext.context);

    // Verify the comment was updated
    const comment = (await supabase.comment.getComment(updateId)) as unknown as CommentMock;
    expect(comment).toBeDefined();
    expect(comment?.embedding).toBeDefined();
  });

  it("When a comment is deleted it should delete it from the database", async () => {
    const { context } = createContext(STRINGS.HELLO_WORLD, 1, 1, 1, "sasasDelete", "1", DEFAULT_HOOK);

    // First create the comment
    await runPlugin(context);

    // Verify comment exists
    const commentBefore = await context.adapters.supabase.comment.getComment("sasasDelete");
    expect(commentBefore).toBeDefined();

    // Delete the comment
    const deleteContext = createContext("Text Message", 1, 1, 1, "sasasDelete", "1", "issue_comment.deleted");
    deleteContext.context.adapters.supabase = context.adapters.supabase;
    await runPlugin(deleteContext.context);

    // Verify comment was deleted
    expect(context.adapters.supabase.comment.getComment("sasasDelete")).rejects.toThrow("Comment does not exist");
  });

  it(
    "When an issue is created with similarity above warning threshold but below match threshold, it should" + " update the issue body with footnotes",
    async () => {
      const [warningThresholdIssue1, warningThresholdIssue2] = fetchSimilarIssues("warning_threshold_75");
      const { context } = createContextIssues(warningThresholdIssue1.issue_body, "warning1", 3, warningThresholdIssue1.title);
      context.eventName = ISSUES_EDITED_EVENT_NAME;

      context.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([]);
      context.adapters.supabase.issue.createIssue = mock(async () => {
        createIssue(
          warningThresholdIssue1.issue_body,
          "warning1",
          warningThresholdIssue1.title,
          3,
          { login: "test", id: 1 },
          "open",
          null,
          STRINGS.TEST_REPO,
          STRINGS.USER_1
        );
      });

      await runPlugin(context);

      const { context: context2 } = createContextIssues(warningThresholdIssue2.issue_body, "warning2", 4, warningThresholdIssue2.title);
      context2.eventName = ISSUES_EDITED_EVENT_NAME;
      context2.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([
        { issue_id: "warning1", similarity: 0.8 },
      ] as unknown as IssueSimilaritySearchResult[]);

      context2.octokit.graphql = mock().mockResolvedValue({
        node: {
          __typename: "Issue",
          title: STRINGS.SIMILAR_ISSUE,
          url: STRINGS.ISSUE_URL,
          number: 3,
          lastEditedAt: DEFAULT_LAST_EDITED_AT,
          body: warningThresholdIssue1.issue_body,
          repository: {
            name: STRINGS.TEST_REPO,
            owner: {
              login: STRINGS.USER_1,
            },
          },
        },
      }) as unknown as typeof context2.octokit.graphql;

      context2.adapters.supabase.issue.createIssue = mock(async () => {
        createIssue(
          warningThresholdIssue2.issue_body,
          "warning2",
          warningThresholdIssue2.title,
          4,
          { login: "test", id: 1 },
          "open",
          null,
          STRINGS.TEST_REPO,
          STRINGS.USER_1
        );
      });

      context2.octokit.rest.issues.update = mock(async (params: { owner: string; repo: string; issue_number: number; body: string }) => {
        // Find the most similar sentence (first sentence in this case)
        const updatedBody =
          warningThresholdIssue2.issue_body.replace(STRINGS.SIMILAR_ISSUE_TITLE, `${STRINGS.SIMILAR_ISSUE_TITLE}[^01^]`) +
          `\n\n[^01^]: ⚠ 80% possible duplicate - [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})\n\n`;

        db.issue.update({
          where: {
            number: { equals: params.issue_number },
          },
          data: {
            body: updatedBody,
          },
        });
      }) as unknown as typeof octokit.rest.issues.update;

      await runPlugin(context2);

      const issue = db.issue.findFirst({ where: { node_id: { equals: "warning2" } } }) as unknown as Context["payload"]["issue"];
      expect(issue.state).toBe("open");
      expect(issue.body).toContain(`[^01^]: ⚠ 80% possible duplicate - [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})`);
    }
  );

  it("When an issue is created with similarity above match threshold, it should close the issue and add a caution alert", async () => {
    const [matchThresholdIssue1, matchThresholdIssue2] = fetchSimilarIssues("match_threshold_95");
    const { context } = createContextIssues(matchThresholdIssue1.issue_body, "match1", 3, matchThresholdIssue1.title);
    context.eventName = ISSUES_EDITED_EVENT_NAME;
    context.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([]);
    context.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        matchThresholdIssue1.issue_body,
        "match1",
        matchThresholdIssue1.title,
        3,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });
    await runPlugin(context);
    const { context: context2 } = createContextIssues(matchThresholdIssue2.issue_body, "match2", 4, matchThresholdIssue2.title);
    context2.eventName = ISSUES_EDITED_EVENT_NAME;

    // Mock the findSimilarIssues function to return a result with similarity above match threshold
    context2.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([
      { issue_id: "match1", similarity: 0.96 },
    ] as unknown as IssueSimilaritySearchResult[]);
    context2.octokit.graphql = mock().mockResolvedValue({
      node: {
        title: STRINGS.SIMILAR_ISSUE,
        url: STRINGS.ISSUE_URL,
        number: 3,
        lastEditedAt: DEFAULT_LAST_EDITED_AT,
        body: matchThresholdIssue1.issue_body,
        repository: {
          name: STRINGS.TEST_REPO,
          owner: {
            login: STRINGS.USER_1,
          },
        },
      },
    }) as unknown as typeof context2.octokit.graphql;

    context2.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        matchThresholdIssue2.issue_body,
        "match2",
        matchThresholdIssue2.title,
        4,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });

    context2.octokit.rest.issues.update = mock(
      async (params: { owner: string; repo: string; issue_number: number; body?: string; state?: string; state_reason?: string }) => {
        const updatedBody = `${matchThresholdIssue2.issue_body}\n\n>[!CAUTION]\n> This issue may be a duplicate of the following issues:\n> - [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})\n`;
        db.issue.update({
          where: {
            number: { equals: params.issue_number },
          },
          data: {
            ...(params.body && { body: updatedBody }),
            ...(params.state && { state: params.state }),
            ...(params.state_reason && { state_reason: params.state_reason }),
          },
        });
      }
    ) as unknown as typeof octokit.rest.issues.update;

    await runPlugin(context2);
    const issue = db.issue.findFirst({ where: { number: { equals: 4 } } }) as unknown as Context["payload"]["issue"];
    expect(issue.state).toBe("closed");
    expect(issue.state_reason).toBe("not_planned");
    expect(issue.body).toContain(">[!CAUTION]");
    expect(issue.body).toContain("This issue may be a duplicate of the following issues:");
    expect(issue.body).toContain(`- [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})`);
    expect(issue.body).not.toMatch(/issues\/\d+#\d+/);
  });

  it("When deduplication generates footnote or caution links, it should not append an issue number hash to the issue URL (#93)", async () => {
    const [warningThresholdIssue1, warningThresholdIssue2] = fetchSimilarIssues("warning_threshold_75");
    const { context } = createContextIssues(warningThresholdIssue1.issue_body, "warning1_hash_test", 3, warningThresholdIssue1.title);
    context.eventName = ISSUES_EDITED_EVENT_NAME;
    context.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([]);
    context.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        warningThresholdIssue1.issue_body,
        "warning1_hash_test",
        warningThresholdIssue1.title,
        3,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });
    await runPlugin(context);

    const { context: context2 } = createContextIssues(warningThresholdIssue2.issue_body, "warning2_hash_test", 4, warningThresholdIssue2.title);
    context2.eventName = ISSUES_EDITED_EVENT_NAME;
    context2.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([
      { issue_id: "warning1_hash_test", similarity: 0.8 },
    ] as unknown as IssueSimilaritySearchResult[]);

    const realIssueUrl = "https://github.com/ubiquity/test-repo/issues/583";
    context2.octokit.graphql = mock().mockResolvedValue({
      node: {
        __typename: "Issue",
        title: "Feature: text-vector-embeddings (Issue #583)",
        url: realIssueUrl,
        number: 583,
        lastEditedAt: DEFAULT_LAST_EDITED_AT,
        body: warningThresholdIssue1.issue_body,
        repository: {
          name: STRINGS.TEST_REPO,
          owner: {
            login: STRINGS.USER_1,
          },
        },
      },
    }) as unknown as typeof context2.octokit.graphql;

    context2.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        warningThresholdIssue2.issue_body,
        "warning2_hash_test",
        warningThresholdIssue2.title,
        4,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });

    let capturedBody = "";
    context2.octokit.rest.issues.update = mock(async (params: { owner: string; repo: string; issue_number: number; body: string }) => {
      capturedBody = params.body;
      db.issue.update({
        where: {
          number: { equals: params.issue_number },
        },
        data: {
          body: params.body,
        },
      });
    }) as unknown as typeof octokit.rest.issues.update;

    await runPlugin(context2);

    expect(capturedBody).toContain("[Feature: text-vector-embeddings (Issue #583)](https://www.github.com/ubiquity/test-repo/issues/583)");
    expect(capturedBody).not.toContain("https://www.github.com/ubiquity/test-repo/issues/583#583");
    expect(capturedBody).not.toMatch(/issues\/583#583/);
  });

  it("When issue matching is triggered, it should suggest contributors based on similarity", async () => {
    const [taskCompleteIssue] = fetchSimilarIssues("task_complete");
    const { context } = createContextIssues(taskCompleteIssue.issue_body, "task_complete", 3, taskCompleteIssue.title);
    context.eventName = ISSUES_EDITED_EVENT_NAME;

    context.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        taskCompleteIssue.issue_body,
        "task_complete",
        taskCompleteIssue.title,
        3,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });

    // Mock the graphql function to return predefined issue data
    context.octokit.graphql = mock().mockResolvedValue({
      node: {
        title: "Similar Issue: Suggest based on Similarity",
        url: STRINGS.ISSUE_URL_TEMPLATE,
        state: "closed",
        stateReason: "COMPLETED",
        closed: true,
        repository: { owner: { login: STRINGS.USER_1 }, name: STRINGS.TEST_REPO },
        assignees: { nodes: [{ login: "contributor1", url: "https://github.com/contributor1" }] },
      },
    }) as unknown as typeof context.octokit.graphql;

    context.octokit.rest.issues.createComment = mock(async (params: { owner: string; repo: string; issue_number: number; body: string }) => {
      createComment(params.body, 1, "task_complete", params.issue_number);
    }) as unknown as typeof octokit.rest.issues.createComment;

    await runPlugin(context);

    const comments = db.issueComments.findMany({ where: { node_id: { equals: "task_complete" } } });
    expect(comments.length).toBe(1);
    expect(comments[0].body).toContain(STRINGS.CONTRIBUTOR_SUGGESTION_TEXT);
    expect(comments[0].body).toContain("contributor1");
    expect(comments[0].body).toContain("98% Match");
  });

  it("When issue matching is triggered with alwaysRecommend enabled, it should suggest contributors regardless of similarity", async () => {
    const [taskCompleteIssue] = fetchSimilarIssues("task_complete");
    const { context } = createContextIssues(taskCompleteIssue.issue_body, "task_complete_always", 6, taskCompleteIssue.title);
    context.eventName = ISSUES_EDITED_EVENT_NAME;

    // Override config to enable alwaysRecommend
    context.config = {
      ...context.config,
      alwaysRecommend: 1,
    };

    context.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        taskCompleteIssue.issue_body,
        "task_complete_always",
        taskCompleteIssue.title,
        6,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });

    // Mock graphql to return issue data with a contributor
    context.octokit.graphql = mock().mockResolvedValue({
      node: {
        title: "Similar Issue",
        url: STRINGS.ISSUE_URL_TEMPLATE,
        state: "closed",
        stateReason: "COMPLETED",
        closed: true,
        repository: { owner: { login: STRINGS.USER_1 }, name: STRINGS.TEST_REPO },
        assignees: { nodes: [{ login: "contributor3", url: "https://github.com/contributor3" }] },
      },
    }) as unknown as typeof context.octokit.graphql;

    context.octokit.rest.issues.createComment = mock(async (params: { owner: string; repo: string; issue_number: number; body: string }) => {
      createComment(params.body, 3, "task_complete_always", params.issue_number);
    }) as unknown as typeof octokit.rest.issues.createComment;

    await runPlugin(context);

    // Verify comment was created despite low similarity
    const comments = db.issueComments.findMany({ where: { node_id: { equals: "task_complete_always" } } });
    expect(comments.length).toBe(1);
    expect(comments[0].body).toContain(STRINGS.CONTRIBUTOR_SUGGESTION_TEXT);
    expect(comments[0].body).toContain("contributor3");
    expect(comments[0].body).toContain("50% Match");
  });

  it("When an issue contains markdown links, footnotes should be added after the entire line", async () => {
    const [markdownLinkIssue1] = fetchSimilarIssues("markdown_link");
    const { context } = createContextIssues(markdownLinkIssue1.issue_body, "markdown1", 7, markdownLinkIssue1.title);

    context.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([]);
    context.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        markdownLinkIssue1.issue_body,
        "markdown1",
        markdownLinkIssue1.title,
        7,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });

    await runPlugin({
      ...context,
      eventName: "issues.opened",
    });

    const { context: context2 } = createContextIssues(markdownLinkIssue1.issue_body, "markdown2", 8, markdownLinkIssue1.title);
    context2.eventName = ISSUES_EDITED_EVENT_NAME;
    context2.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([
      { issue_id: "markdown1", similarity: 0.8 },
    ] as unknown as IssueSimilaritySearchResult[]);

    context2.octokit.graphql = mock().mockResolvedValue({
      node: {
        title: markdownLinkIssue1.title,
        url: STRINGS.ISSUE_URL,
        number: 7,
        lastEditedAt: "2022-01-12T17:52:02Z",
        body: markdownLinkIssue1.issue_body,
        repository: {
          name: STRINGS.TEST_REPO,
          owner: {
            login: STRINGS.USER_1,
          },
        },
      },
    }) as unknown as typeof context2.octokit.graphql;

    context2.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(
        markdownLinkIssue1.issue_body,
        "markdown2",
        markdownLinkIssue1.title,
        8,
        { login: "test", id: 1 },
        "open",
        null,
        STRINGS.TEST_REPO,
        STRINGS.USER_1
      );
    });

    context2.octokit.rest.issues.update = mock(async (params: { owner: string; repo: string; issue_number: number; body: string }) => {
      // The footnote should be added after the entire line containing the markdown link
      db.issue.update({
        where: {
          number: { equals: params.issue_number },
        },
        data: {
          body: params.body,
        },
      });
    }) as unknown as typeof octokit.rest.issues.update;

    await runPlugin(context2);

    const issue = db.issue.findFirst({ where: { node_id: { equals: "markdown2" } } }) as unknown as Context["payload"]["issue"];
    expect(issue.state).toBe("open");
    // Verify the footnote is added after the line containing the markdown link
    expect(issue.body).toContain(
      "_Originally posted by @0x4007 in https://www.github.com/ubiquity-os-marketplace/command-start-stop/issues/100#issuecomment-2535532258_ [^01^]"
    );
    // Verify the markdown link is not broken
    expect(issue.body).not.toContain(
      "_Originally posted by @0x4007 in https://www.github.com/ubiquity-os-marketplace/command-start-stop/issues/100#issuecomment-2535532258_[^01^]"
    );
  });

  it("When a user uses default annotate command and last comment has similarity above annotate threshold, it should update comment body with footnotes", async () => {
    const [annotateIssue] = fetchSimilarIssues("annotate");
    const { context } = createContextIssues(annotateIssue.issue_body, "annotate", 9, annotateIssue.title);
    context.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([]);
    context.adapters.supabase.comment.findSimilarComments = mock().mockResolvedValue([]);
    context.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(annotateIssue.issue_body, "annotate", annotateIssue.title, 9, { login: "test", id: 1 }, "open", null, STRINGS.TEST_REPO, STRINGS.USER_1);
    });

    await runPlugin(context);

    createComment(annotateComment.body, annotateComment.id, "annotate", 9);

    const { context: context2, comment } = createContext("/annotate", 1, 1, 2, "createAnnotate", "annotate");

    context2.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([
      { issue_id: "annotate", similarity: 0.88 },
    ] as unknown as IssueSimilaritySearchResult[]);
    context2.adapters.supabase.comment.findSimilarComments = mock().mockResolvedValue([]);
    context2.octokit.graphql = mock().mockResolvedValue({
      node: {
        __typename: "Issue",
        title: STRINGS.SIMILAR_ISSUE,
        url: STRINGS.ISSUE_URL,
        number: 9,
        body: annotateIssue.issue_body,
        repository: {
          name: STRINGS.TEST_REPO,
          owner: {
            login: STRINGS.USER_1,
          },
        },
      },
    }) as unknown as typeof context2.octokit.graphql;

    context2.octokit.rest.issues.listComments = mock(async () => {
      return { data: [annotateComment, comment] };
    }) as unknown as typeof octokit.rest.issues.listComments;

    context2.octokit.rest.issues.updateComment = mock(async (params: { owner: string; repo: string; comment_id: number; body: string }) => {
      // Find the most similar sentence (first sentence in this case)
      const updatedBody =
        annotateComment.body.replace(STRINGS.SIMILAR_COMMENT, `${STRINGS.SIMILAR_COMMENT}[^01^]`) +
        `\n\n[^01^]: 88% similar to issue: [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})\n\n`;

      db.issueComments.update({
        where: {
          id: { equals: params.comment_id },
        },
        data: {
          body: updatedBody,
        },
      });
    }) as unknown as typeof octokit.rest.issues.updateComment;

    await runPlugin(context2);

    const updatedComment = db.issueComments.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context<"issue_comment.created">["payload"]["comment"];
    expect(updatedComment.body).toContain(`[^01^]: 88% similar to issue: [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})`);
  });

  it("When demoFlag is true, it should skip storing issues in the database", async () => {
    const { context } = createContextIssues(DEFAULT_BODY, "demoIssue", 10, "Demo Test Issue");

    // Enable demo mode
    context.config = {
      ...context.config,
      demoFlag: true,
    };

    await runPlugin(context);

    // Verify the issue was not stored in the database
    expect(context.adapters.supabase.issue.getIssue("demoIssue")).resolves.toBeNull();
  });

  it("When demoFlag is true, it should skip storing comments in the database", async () => {
    const { context } = createContext(DEFAULT_BODY, 1, 1, 1, "demoComment", DEFAULT_ISSUE_ID);

    // Enable demo mode
    context.config = {
      ...context.config,
      demoFlag: true,
    };

    await runPlugin(context);

    // Verify the comment was not stored in the database
    expect(context.adapters.supabase.comment.getComment("demoComment")).rejects.toThrow();
  });

  it("When demoFlag is false (default), it should store issues in the database", async () => {
    const { context } = createContextIssues(DEFAULT_BODY, "normalIssue", 11, "Normal Test Issue");
    context.config.demoFlag = false;
    await runPlugin(context);

    // Verify the issue was stored in the database
    const issue = (await context.adapters.supabase.issue.getIssue("normalIssue")) as unknown as IssueMock;
    expect(issue).toBeDefined();
    expect(issue.markdown).toContain(DEFAULT_BODY);
  });

  it("When demoFlag is false (default), it should store comments in the database", async () => {
    const { context } = createContext(DEFAULT_BODY, 1, 1, 1, "normalComment", DEFAULT_ISSUE_ID);
    await runPlugin(context);

    // Verify the comment was stored in the database
    const comment = (await context.adapters.supabase.comment.getComment("normalComment")) as unknown as CommentMock;
    expect(comment).toBeDefined();
    expect(comment.embedding).toBeDefined();
  });

  it("When a user uses annotate command with a specified comment and 'repo' scope and the comment doesn't have similarity above match threshold with any issue from the same repository, it shouldn't update comment body with footnotes", async () => {
    const [annotateIssue] = fetchSimilarIssues("annotate");
    const { context } = createContextIssues(annotateIssue.issue_body, "annotate", 9, annotateIssue.title);
    context.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([]);
    context.adapters.supabase.comment.findSimilarComments = mock().mockResolvedValue([]);
    context.adapters.supabase.issue.createIssue = mock(async () => {
      createIssue(annotateIssue.issue_body, "annotate", annotateIssue.title, 9, { login: "test", id: 1 }, "open", null, STRINGS.TEST_REPO2, STRINGS.USER_1);
    });

    await runPlugin(context);

    createComment(annotateComment.body, annotateComment.id, "annotate", 9);

    const { context: context2 } = createContext("/annotate /#issuecomment-1 repo", 1, 1, 2, "createAnnotate", "annotate");

    context2.adapters.supabase.issue.findSimilarIssues = mock().mockResolvedValue([
      { issue_id: "annotate", similarity: 0.88 },
    ] as unknown as IssueSimilaritySearchResult[]);
    context2.adapters.supabase.comment.findSimilarComments = mock().mockResolvedValue([]);
    context2.octokit.graphql = mock().mockResolvedValue({
      node: {
        __typename: "Issue",
        title: STRINGS.SIMILAR_ISSUE,
        url: STRINGS.ISSUE_URL,
        number: 9,
        body: annotateIssue.issue_body,
        repository: {
          name: STRINGS.TEST_REPO2,
          owner: {
            login: STRINGS.USER_1,
          },
        },
      },
    }) as unknown as typeof context2.octokit.graphql;

    context2.octokit.rest.issues.getComment = mock(async () => {
      return { data: annotateComment };
    }) as unknown as typeof octokit.rest.issues.getComment;

    context2.octokit.rest.issues.updateComment = mock(async (params: { owner: string; repo: string; comment_id: number; body: string }) => {
      // Find the most similar sentence (first sentence in this case)
      const updatedBody =
        annotateComment.body.replace(STRINGS.SIMILAR_COMMENT, `${STRINGS.SIMILAR_COMMENT}[^01^]`) +
        `\n\n[^01^]: 88% similar to issue: [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})\n\n`;

      db.issueComments.update({
        where: {
          id: { equals: params.comment_id },
        },
        data: {
          body: updatedBody,
        },
      });
    }) as unknown as typeof octokit.rest.issues.updateComment;

    await runPlugin(context2);

    const updatedComment = db.issueComments.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context<"issue_comment.created">["payload"]["comment"];
    expect(updatedComment.body).not.toContain(`[^01^]: 88% similar to issue: [${STRINGS.SIMILAR_ISSUE}](${STRINGS.ISSUE_URL})`);
  });

  function createContext(
    commentBody: string = "Hello, world!",
    repoId: number = 1,
    payloadSenderId: number = 1,
    commentId: number = 1,
    nodeId: string = "sasas",
    issueNodeId: string = "1",
    eventName: Context["eventName"] = DEFAULT_HOOK
  ) {
    const repo = db.repo.findFirst({ where: { id: { equals: repoId } } }) as unknown as Context["payload"]["repository"];
    const sender = db.users.findFirst({ where: { id: { equals: payloadSenderId } } }) as unknown as Context["payload"]["sender"];
    const issue1 = db.issue.findFirst({ where: { node_id: { equals: issueNodeId } } }) as unknown as Context["payload"]["issue"];
    createComment(commentBody, commentId, nodeId);
    const comment = db.issueComments.findFirst({
      where: { id: { equals: commentId } },
    }) as unknown as Context<"issue_comment.created">["payload"]["comment"];

    const context = createContextInner(repo, sender, issue1, comment, eventName);
    context.adapters = createMockAdapters(context) as unknown as Context["adapters"];
    const infoSpy = spyOn(context.logger, "info");
    const errorSpy = spyOn(context.logger, "error");
    const debugSpy = spyOn(context.logger, "debug");
    const okSpy = spyOn(context.logger, "ok");
    const verboseSpy = spyOn(context.logger, "verbose");

    return {
      context,
      comment,
      infoSpy,
      errorSpy,
      debugSpy,
      okSpy,
      verboseSpy,
      repo,
      issue1,
    };
  }

  function createContextInner(
    repo: Context["payload"]["repository"],
    sender: Context["payload"]["sender"],
    issue: Context["payload"]["issue"],
    comment: Context<"issue_comment.created">["payload"]["comment"] | undefined,
    eventName: Context["eventName"] = DEFAULT_HOOK
  ): Context {
    return {
      eventName: eventName,
      payload: {
        action: "created",
        sender: sender,
        repository: repo,
        issue: issue,
        ...(comment && { comment: comment }),
        installation: { id: 1 } as Context["payload"]["installation"],
        organization: { login: STRINGS.USER_1 } as Context["payload"]["organization"],
      } as Context["payload"],
      config: {
        dedupeWarningThreshold: 0.75,
        dedupeMatchThreshold: 0.95,
        jobMatchingThreshold: 0.95,
        annotateThreshold: 0.65,
        demoFlag: false,
      },
      command: null,
      adapters: {} as Context["adapters"],
      logger: new Logs("debug") as unknown as Context["logger"],
      env: { DATABASE_URL: "postgres://db.example/text-vector-embeddings", EMBEDDINGS_QUEUE_ENABLED: "false" } as Env,
      octokit: octokit,
    };
  }

  function createContextIssues(
    issueBody: string = "Hello, world!",
    issueNodeId: string = "sasas",
    issueNumber: number = 1,
    issueTitle: string = "Test Issue",
    issueUser: {
      login: string;
      id: number;
    } = { login: "test", id: 1 },
    issueState: string = "open",
    issueCloseReason: string | null = null,
    eventName: Context["eventName"] = "issues.opened"
  ) {
    const repo = db.repo.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["repository"];
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["sender"];

    createIssue(issueBody, issueNodeId, issueTitle, issueNumber, issueUser, issueState, issueCloseReason, STRINGS.TEST_REPO, STRINGS.USER_1);

    const issue = db.issue.findFirst({
      where: { node_id: { equals: issueNodeId } },
    }) as unknown as Context["payload"]["issue"];

    const context = createContextInner(repo, sender, issue, undefined, eventName);
    context.adapters = createMockAdapters(context) as unknown as Context["adapters"];

    return { context, repo, issue };
  }
});
