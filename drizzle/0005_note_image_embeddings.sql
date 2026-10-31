CREATE TABLE "note_image_embeddings" (
	"image_id" text PRIMARY KEY NOT NULL,
	"embedding" vector(1536),
	"image_sha256" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_image_embeddings" ADD CONSTRAINT "note_image_embeddings_image_id_note_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."note_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_image_embeddings_embedding_hnsw_idx" ON "note_image_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "note_image_embeddings_next_attempt_idx" ON "note_image_embeddings" USING btree ("next_attempt_at");