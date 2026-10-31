CREATE TABLE "chat_images" (
	"id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"original_name" text,
	"host" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_images_source_check" CHECK ("chat_images"."source" in ('wall', 'claude_code'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_images_sha256_uniq" ON "chat_images" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_images_path_uniq" ON "chat_images" USING btree ("path");--> statement-breakpoint
CREATE INDEX "chat_images_created_at_idx" ON "chat_images" USING btree ("created_at");