import { StaticDecode, Type as T } from "@sinclair/typebox";

/**
 * This should contain the properties of the bot config
 * that are required for the plugin to function.
 *
 * The kernel will extract those and pass them to the plugin,
 * which are built into the context object from setup().
 */
export const pluginSettingsSchema = T.Object(
  {
    dedupeMatchThreshold: T.Number({ default: 0.95, description: "The minimum similarity score when considering existing issues to be duplicates." }),
    dedupeWarningThreshold: T.Number({ default: 0.75, description: "Issues above this similarity score will be marked as a potential duplicate." }),
    annotateThreshold: T.Number({
      default: 0.65,
      description: "The minimum similarity score for including similar issues as annotations in the comment footnotes.",
    }),
    jobMatchingThreshold: T.Number({ default: 0.75, description: "The minimum similarity score when considering users to be suitable for a job." }),
    alwaysRecommend: T.Optional(
      T.Number({ default: 0, description: "If set to a value greater than 0, the bot will always recommend contributors, regardless of the similarity score." })
    ),
    embeddingModel: T.Optional(
      T.Union([T.Literal("voyage"), T.Literal("nomic")], {
        default: "voyage",
        description: "The vector embedding model to use for similarity search ('voyage' or 'nomic').",
      })
    ),
    demoFlag: T.Boolean({ default: false, description: "When true, disables storing issues and comments in the database." }),
  },
  { default: {} }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
