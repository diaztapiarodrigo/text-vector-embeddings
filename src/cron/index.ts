import { createAppAuth } from "@octokit/auth-app";
import { ConfigurationHandler } from "@ubiquity-os/plugin-sdk/configuration";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import manifest from "../../manifest.json" with { type: "json" };
import "../adapters/preload-deno-postgres";
import { createPostgresIssueStore } from "../adapters/postgres-issue-store";
import type { Context } from "../types/index";
import { getEmbeddingQueueSettings, sleep } from "../utils/embedding-queue";
import { processPendingEmbeddings } from "./embedding-queue";
import { createReprocessClients, createReprocessContext, decodeConfig, decodeEnv, reprocessIssue } from "./reprocess";

function normalizeError(error: unknown): Error | { stack: string } {
  return error instanceof Error ? error : { stack: String(error) };
}

async function main() {
  const logger = new Logs((process.env.LOG_LEVEL as LogLevel) ?? LOG_LEVEL.INFO) as unknown as Context["logger"];
  let env;
  try {
    env = decodeEnv(process.env);
  } catch (error) {
    logger.warn("Missing required env for reprocess; skipping cron run.", { error: normalizeError(error) });
    return;
  }
  const clients = createReprocessClients(env);
  const queueSettings = getEmbeddingQueueSettings(env);
  const issueStore = await createPostgresIssueStore(env.DATABASE_URL);

  try {
    try {
      const queueResult = await processPendingEmbeddings({ env, clients, logger });
      logger.ok("Embedding queue processed", queueResult);
      if (queueResult.stoppedEarly) {
        logger.warn("Embedding queue stopped early due to rate limiting; skipping reprocess run.");
        return;
      }
    } catch (error) {
      logger.error("Embedding queue failed", { error: normalizeError(error) });
      throw error;
    }

    const appIdRaw = process.env.APP_ID;
    const appId = Number(appIdRaw);
    const appPrivateKey = process.env.APP_PRIVATE_KEY ?? "";
    const appInstallationIdRaw = process.env.APP_INSTALLATION_ID;
    const appInstallationId = Number(appInstallationIdRaw);
    if (!appIdRaw || Number.isNaN(appId) || !appPrivateKey || !appInstallationIdRaw || Number.isNaN(appInstallationId)) {
      logger.warn("APP_ID, APP_PRIVATE_KEY, or APP_INSTALLATION_ID are missing/invalid in the env; skipping cron run.");
      return;
    }

    const octokit = new customOctokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey: appPrivateKey,
        installationId: appInstallationId,
      },
    });

    const repositories = await issueStore.getAllRepositories();

    logger.ok(`Loaded tracked issue data.`, {
      repositories: repositories.length,
    });

    for (const { owner, repo, issueNumbers } of repositories) {
      if (issueNumbers.length === 0) {
        continue;
      }

      try {
        logger.info(`Triggering update`, {
          organization: owner,
          repository: repo,
          issueIds: issueNumbers,
        });

        const installation = await octokit.rest.apps.getRepoInstallation({ owner, repo });

        const repoOctokit = new customOctokit({
          authStrategy: createAppAuth,
          auth: {
            appId,
            privateKey: appPrivateKey,
            installationId: installation.data.id,
          },
        });

        const configurationHandler = new ConfigurationHandler(logger, repoOctokit);
        const repoConfig = await configurationHandler.getSelfConfiguration<Record<string, unknown>>(manifest as Pick<Manifest, "short_name">, {
          owner,
          repo,
        });
        const config = decodeConfig(repoConfig ?? {});

        const appAuth = createAppAuth({
          appId,
          privateKey: appPrivateKey,
          installationId: installation.data.id,
        });
        const { token: authToken } = await appAuth({ type: "installation" });

        const repoResponse = await repoOctokit.rest.repos.get({ owner, repo });
        const repository = repoResponse.data;

        for (const issueNumber of issueNumbers) {
          const url = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
          try {
            const { data: issue } = await repoOctokit.rest.issues.get({
              owner,
              repo,
              issue_number: issueNumber,
            });
            if (issue.pull_request) {
              logger.debug("Skipping pull request entry in tracked issue list", { owner, repo, issueNumber });
              await issueStore.removeIssue(url);
              continue;
            }

            const context = await createReprocessContext({
              issue,
              repository,
              octokit: repoOctokit,
              authToken,
              env,
              config,
              logger,
              clients,
            });

            await reprocessIssue(context, {
              updateIssue: false,
              runMatching: true,
              runDedupe: true,
              keepUpdateComment: false,
            });

            await issueStore.removeIssue(url);
          } catch (err) {
            logger.error("Failed to reprocess individual issue", {
              organization: owner,
              repository: repo,
              issueNumber,
              url,
              err,
            });
          }

          if (queueSettings.enabled) {
            await sleep(queueSettings.delayMs);
          }
        }
      } catch (e) {
        logger.error("Failed to process repository", {
          owner,
          repo,
          issueNumbers,
          e,
        });
      }
    }
  } finally {
    await issueStore.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
