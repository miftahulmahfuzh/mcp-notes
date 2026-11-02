CREATE TABLE "cc_subagent_transcripts" (
	"transcript_path" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"host" text NOT NULL,
	"transcript_offset" bigint DEFAULT 0 NOT NULL,
	"transcript_size" bigint,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cc_subagent_transcripts_session_idx" ON "cc_subagent_transcripts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "cc_subagent_transcripts_host_idx" ON "cc_subagent_transcripts" USING btree ("host");