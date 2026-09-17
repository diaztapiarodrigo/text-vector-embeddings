import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { Context } from "../types/index";
import { createPostgresIssueStore, IssueStore } from "./postgres-issue-store";
import { LlmAdapter } from "./llm/index";
import { Comment } from "./supabase/helpers/comment";
import { Issue } from "./supabase/helpers/issues";
import { SuperSupabase } from "./supabase/helpers/supabase";
import { Embedding as VoyageEmbedding } from "./voyage/helpers/embedding";
import { SuperVoyage } from "./voyage/helpers/voyage";
import { Embedding as NomicEmbedding } from "./nomic/helpers/embedding";
import { SuperNomic } from "./nomic/helpers/nomic";

type AdapterSet = {
  supabase: {
    comment: Comment;
    issue: Issue;
    super: SuperSupabase;
  };
  voyage: {
    embedding: VoyageEmbedding;
    super: SuperVoyage;
  };
  nomic: {
    embedding: NomicEmbedding;
    super: SuperNomic;
  };
  issueStore: IssueStore;
  llm: LlmAdapter;
  close(): Promise<void>;
};

export async function createAdapters(supabaseClient: SupabaseClient, voyage: VoyageAIClient, context: Context): Promise<AdapterSet> {
  const issueStore = await createPostgresIssueStore(context.env.DATABASE_URL);

  return {
    supabase: {
      comment: new Comment(supabaseClient, context),
      issue: new Issue(supabaseClient, context),
      super: new SuperSupabase(supabaseClient, context),
    },
    voyage: {
      embedding: new VoyageEmbedding(voyage, context),
      super: new SuperVoyage(voyage, context),
    },
    nomic: {
      embedding: new NomicEmbedding(context),
      super: new SuperNomic(context),
    },
    issueStore,
    llm: new LlmAdapter(context),
    close: async () => {
      await issueStore.close();
    },
  };
}
