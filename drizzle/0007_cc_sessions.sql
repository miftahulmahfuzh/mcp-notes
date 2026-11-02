CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cc_pending_spawns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"parent_session_id" text NOT NULL,
	"cwd" text NOT NULL,
	"name" text,
	"host" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cc_session_embeddings" (
	"session_id" text PRIMARY KEY NOT NULL,
	"embedding" vector(1536),
	"sha" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cc_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"host" text NOT NULL,
	"repo" text,
	"cwd" text,
	"branch" text,
	"name" text,
	"custom_title" text,
	"ai_title" text,
	"first_prompt" text,
	"last_prompt" text,
	"entrypoint" text,
	"version" text,
	"started_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_session_id" text,
	"parent_link_source" text,
	"tmux" text,
	"transcript_path" text,
	"transcript_offset" bigint DEFAULT 0 NOT NULL,
	"transcript_size" bigint,
	"prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files_edited" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_docs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_message" text,
	"summary" text,
	"summary_sha" text,
	"summarized_at" timestamp with time zone,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_sessions_node_id_check" CHECK ("cc_sessions"."node_id" ~ '^[0-9A-Z]{2}-[0-9A-Z]{2}$'),
	CONSTRAINT "cc_sessions_parent_link_source_check" CHECK ("cc_sessions"."parent_link_source" in ('env', 'hook', 'heuristic')),
	CONSTRAINT "cc_sessions_parent_pair_check" CHECK (("cc_sessions"."parent_session_id" is null) = ("cc_sessions"."parent_link_source" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "project" text;--> statement-breakpoint
ALTER TABLE "cc_session_embeddings" ADD CONSTRAINT "cc_session_embeddings_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cc_pending_spawns_open_idx" ON "cc_pending_spawns" USING btree ("host","cwd","created_at") WHERE "cc_pending_spawns"."claimed_by" is null;--> statement-breakpoint
CREATE INDEX "cc_pending_spawns_created_idx" ON "cc_pending_spawns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cc_session_embeddings_embedding_hnsw_idx" ON "cc_session_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "cc_session_embeddings_next_attempt_idx" ON "cc_session_embeddings" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cc_sessions_node_id_uniq" ON "cc_sessions" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "cc_sessions_repo_started_idx" ON "cc_sessions" USING btree ("repo","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cc_sessions_parent_idx" ON "cc_sessions" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX "cc_sessions_host_idx" ON "cc_sessions" USING btree ("host");--> statement-breakpoint
CREATE INDEX "cc_sessions_name_idx" ON "cc_sessions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "cc_sessions_last_active_idx" ON "cc_sessions" USING btree ("last_active_at");--> statement-breakpoint
CREATE INDEX "cc_sessions_search_gin" ON "cc_sessions" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "chat_threads_project_updated_idx" ON "chat_threads" USING btree ("project","updated_at");