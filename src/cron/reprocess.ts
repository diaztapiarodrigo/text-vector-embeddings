import { Value } from "@sinclair/typebox/value";
import { SupabaseClient, createClient } from "@supabase/supabase-js";
import { CommentHandler } from "@ubiquity-os/plugin-sdk";
import type { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { VoyageAIClient } from "voyageai";
import { IssueStore, TrackedRepository } from "../adapters/postgres-issue-store";
import { LlmAdapter } from "../adapters/llm";
import { Comment } from "../adapters/supabase/helpers/comment";
import { Issue } from "../adapters/supabase/helpers/issues";
import { SuperSupabase } from "../adapters/supabase/helpers/supabase";
import { Embedding as VoyageEmbedding } from "../adapters/voyage/helpers/embedding";
import { SuperVoyage } from "../adapters/voyage/helpers/voyage";
import { Embedding as NomicEmbedding } from "../adapters/nomic/helpers/embedding";
import { SuperNomic } from "../adapters/nomic/helpers/nomic";
import { issueDedupe } from "../handlers/issue-deduplication";
import { issueMatchingWithComment } from "../handlers/issue-matching";
import { updateIssue } from "../handlers/update-issue";
import { parseGitHubUrl } from "../helpers/github";
import { Database } from "../types/database";
import { Context, Env, PluginSettings, envSchema, pluginSettingsSchema } from "../types/index";

type Octokit = InstanceType<typeof customOctokit>;
type IssuePayload = Awaited<ReturnType<Octokit["rest"]["issues"]["get"]>>["data"];
type RepoPayload = Awaited<ReturnType<Octokit["rest"]["repos"]["get"]>>["data"];
type ReprocessAdapters = ReturnType<typeof createReprocessAdapters>;
type ReprocessContext = Omit<Context<"issues.edited">, "adapters"> & { adapters: ReprocessAdapters };

export type ReprocessOptions = {
  updateIssue?: boolean;
  runMatching?: boolean;
  runDedupe?: boolean;
  keepUpdateComment?: boolean;
};

type ReprocessClients = {
  supabase: SupabaseClient<Database>;
  voyage: VoyageAIClient;
};

class MemoryIssueStore implements IssueStore {
  private readonly _entries = new Map<string, number[]>();

  async getIssueNumbers(owner: string, repo: string): Promise<number[]> {
    return this._entries.get(`${owner}/${repo}`) ?? [];
  }

  async addIssue(url: string): Promise<void> {
    const { owner, repo, issue_number } = parseGitHubUrl(url);
    const key = `${owner}/${repo}`;
    const current = this._entries.get(key) ?? [];
    if (!current.includes(issue_number)) {
      this._entries.set(key, [...current, issue_number]);
    }
  }

  async removeIssue(url: string): Promise<void> {
    const { owner, repo, issue_number } = parseGitHubUrl(url);
    const key = `${owner}/${repo}`;
    const current = this._entries.get(key) ?? [];
    const filtered = current.filter((id) => id !== issue_number);
    if (filtered.length === 0) {
      this._entries.delete(key);
    } else {
      this._entries.set(key, filtered);
    }
  }

  async updateIssue(currentUrl: string, newUrl: string): Promise<void> {
    await this.removeIssue(currentUrl);
    await this.addIssue(newUrl);
  }

  async getAllRepositories(): Promise<TrackedRepository[]> {
    const repositories: TrackedRepository[] = [];
    for (const [key, issueNumbers] of this._entries) {
      const [owner, repo] = key.split("/");
      if (!owner || !repo) {
        continue;
      }
      repositories.push({ owner, repo, issueNumbers });
    }
    return repositories;
  }

  async hasData(): Promise<boolean> {
    return this._entries.size > 0;
  }

  async close(): Promise<void> {}
}

export function decodeEnv(values: Record<string, unknown>): Env {
  return Value.Decode(envSchema, Value.Default(envSchema, values));
}

export function decodeConfig(values: Record<string, unknown> = {}): PluginSettings {
  return Value.Decode(pluginSettingsSchema, Value.Default(pluginSettingsSchema, values));
}

export function createReprocessClients(env: Env): ReprocessClients {
  return {
    supabase: createClient<Database>(env.SUPABASE_URL, env.SUPABASE_KEY),
    voyage: new VoyageAIClient({ apiKey: env.VOYAGEAI_API_KEY }),
  };
}

export function createReprocessAdapters(context: Context, clients: ReprocessClients): Context["adapters"] {
  const issueStore: IssueStore = new MemoryIssueStore();
  return {
    supabase: {
      comment: new Comment(clients.supabase, context),
      issue: new Issue(clients.supabase, context),
      super: new SuperSupabase(clients.supabase, context),
    },
    voyage: {
      embedding: new VoyageEmbedding(clients.voyage, context),
      super: new SuperVoyage(clients.voyage, context),
    },
    nomic: {
      embedding: new NomicEmbedding(context),
      super: new SuperNomic(context),
    },
    issueStore,
    llm: new LlmAdapter(context),
    close: async () => {},
  };
}

export async function createReprocessContext(params: {
  issue: IssuePayload;
  repository: RepoPayload;
  octokit: Context<"issues.edited">["octokit"];
  authToken?: string;
  env: Env;
  config?: PluginSettings;
  logger?: Context<"issues.edited">["logger"];
  clients?: ReprocessClients;
}): Promise<Context<"issues.edited">> {
  const logger =
    (params.logger as Context<"issues.edited">["logger"]) ??
    (new Logs((process.env.LOG_LEVEL as LogLevel) ?? LOG_LEVEL.INFO) as unknown as Context<"issues.edited">["logger"]);
  const config = params.config ?? decodeConfig();
  const ctx: ReprocessContext = {
    eventName: "issues.edited",
    command: null,
    commentHandler: new CommentHandler(),
    authToken: params.authToken ?? "",
    payload: {
      issue: params.issue,
      repository: params.repository,
      sender: { type: "Bot" },
    } as Context<"issues.edited">["payload"],
    octokit: params.octokit,
    env: params.env,
    config,
    logger,
    adapters: {} as ReprocessContext["adapters"],
  };
  const clients = params.clients ?? createReprocessClients(params.env);
  ctx.adapters = createReprocessAdapters(ctx, clients);
  return ctx;
}

export async function reprocessIssue(context: Context<"issues.edited">, options: ReprocessOptions = {}) {
  const shouldRunUpdate = options.updateIssue ?? true;
  const shouldRunMatching = options.runMatching ?? true;
  const shouldRunDedupe = options.runDedupe ?? true;
  const shouldKeepUpdateComment = options.keepUpdateComment ?? false;

  if (shouldRunUpdate) {
    await updateIssue(context);
  }

  if (shouldRunMatching) {
    await issueMatchingWithComment(context);
  }

  if (shouldRunDedupe) {
    await issueDedupe(context, { keepUpdateComment: shouldKeepUpdateComment });
  }
}
