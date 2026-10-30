CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "note_embeddings" (
	"note_id" text PRIMARY KEY NOT NULL,
	"embedding" vector(1536),
	"body_sha256" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_embeddings" ADD CONSTRAINT "note_embeddings_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_embeddings_embedding_hnsw_idx" ON "note_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "note_embeddings_next_attempt_idx" ON "note_embeddings" USING btree ("next_attempt_at");