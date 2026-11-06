CREATE TABLE "cc_session_replies" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone,
	"text" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
	CONSTRAINT "cc_session_replies_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "cc_session_reply_embeddings" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"embedding" vector(1536),
	"sha" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_session_reply_embeddings_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "replies_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_session_replies" ADD CONSTRAINT "cc_session_replies_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_session_reply_embeddings" ADD CONSTRAINT "cc_session_reply_embeddings_reply_fk" FOREIGN KEY ("session_id","seq") REFERENCES "public"."cc_session_replies"("session_id","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cc_session_replies_search_gin" ON "cc_session_replies" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "cc_session_reply_embeddings_embedding_hnsw_idx" ON "cc_session_reply_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "cc_session_reply_embeddings_next_attempt_idx" ON "cc_session_reply_embeddings" USING btree ("next_attempt_at");