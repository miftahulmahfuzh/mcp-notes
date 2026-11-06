DROP INDEX IF EXISTS "cc_sessions_search_gin";--> statement-breakpoint
ALTER TABLE "cc_sessions" drop column "search_tsv";--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", '') || ' ' || coalesce(jsonb_path_query_array("commits", '$[*].subject')::text, ''))) STORED;--> statement-breakpoint
ALTER TABLE "cc_session_embeddings" ADD COLUMN "text_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "cc_sessions_search_gin" ON "cc_sessions" USING gin ("search_tsv");
