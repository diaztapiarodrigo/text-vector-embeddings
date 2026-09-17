import { http, HttpResponse } from "msw";
import { db } from "./db";

/**
 * Intercepts the routes and returns a custom payload
 */
export const handlers = [
  //Handle graphql request
  http.post("https://api.github.com/graphql", async ({ request }) => {
    const { query } = await getValue(request.body);
    if (query.includes("query ($issueNodeId: ID!)")) {
      return HttpResponse.json({
        data: {
          node: {
            lastEditedAt: "2020-01-12T17:52:02Z",
          },
        },
      });
    }

    return HttpResponse.json({
      data: {},
    });
  }),

  // get org repos
  http.get("https://api.github.com/orgs/:org/repos", ({ params: { org } }: { params: { org: string } }) =>
    HttpResponse.json(db.repo.findMany({ where: { owner: { login: { equals: org } } } }))
  ),
  // get org repo issues
  http.get("https://api.github.com/repos/:owner/:repo/issues", ({ params: { owner, repo } }) =>
    HttpResponse.json(db.issue.findMany({ where: { owner: { equals: owner as string }, repo: { equals: repo as string } } }))
  ),
  // get issue
  http.get("https://api.github.com/repos/:owner/:repo/issues/:issue_number", ({ params: { owner, repo, issue_number: issueNumber } }) =>
    HttpResponse.json(
      db.issue.findFirst({ where: { owner: { equals: owner as string }, repo: { equals: repo as string }, number: { equals: Number(issueNumber) } } })
    )
  ),
  // get user
  http.get("https://api.github.com/users/:username", ({ params: { username } }) =>
    HttpResponse.json(db.users.findFirst({ where: { login: { equals: username as string } } }))
  ),
  // get repo
  http.get("https://api.github.com/repos/:owner/:repo", ({ params: { owner, repo } }: { params: { owner: string; repo: string } }) => {
    const item = db.repo.findFirst({ where: { name: { equals: repo }, owner: { login: { equals: owner } } } });
    if (!item) {
      return new HttpResponse(null, { status: 404 });
    }
    return HttpResponse.json(item);
  }),
  // create comment
  http.post("https://api.github.com/repos/:owner/:repo/issues/:issue_number/comments", async ({ params: { issue_number: issueNumber }, request }) => {
    const { body } = await getValue(request.body);
    const id = db.issueComments.count() + 1;
    const newItem = { id, body, issue_number: Number(issueNumber), user: db.users.getAll()[0] };
    db.issueComments.create(newItem);
    return HttpResponse.json(newItem);
  }),
  // update comment
  http.patch("https://api.github.com/repos/:owner/:repo/issues/comments/:comment_id", async ({ params: { comment_id: commentId }, request }) => {
    const { body } = await getValue(request.body);
    const item = db.issueComments.findFirst({ where: { id: { equals: Number(commentId) } } });
    if (!item) {
      return new HttpResponse(null, { status: 404 });
    }
    item.body = body;
    return HttpResponse.json(item);
  }),
  //Update issue
  http.patch("https://api.github.com/repos/:owner/:repo/issues/:issue_number", async ({ params: { issue_number: issueNumber }, request }) => {
    const { body } = await getValue(request.body);
    const item = db.issue.findFirst({ where: { number: { equals: Number(issueNumber) } } });
    if (!item) {
      return new HttpResponse(null, { status: 404 });
    }
    item.body = body;
    return HttpResponse.json(item);
  }),

  //Fetch comments for the issue
  http.get("https://api.github.com/repos/:owner/:repo/issues/:issue_number/comments", ({ params: { issue_id: issueId } }) =>
    HttpResponse.json(db.issueComments.findMany({ where: { issue_id: { equals: String(issueId) } } }))
  ),

  // Mock external github web page requests to avoid network calls
  http.get("https://www.github.com/*", () => new HttpResponse("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } })),
  http.get("https://github.com/*", () => new HttpResponse("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } })),
];

async function getValue(body: ReadableStream<Uint8Array> | null) {
  if (body) {
    const reader = body.getReader();
    const streamResult = await reader.read();
    if (!streamResult.done) {
      const text = new TextDecoder().decode(streamResult.value);
      try {
        return JSON.parse(text);
      } catch (error) {
        console.error("Failed to parse body as JSON", error);
      }
    }
  }
  return {};
}
