CREATE TABLE "note_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"body" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_path" text,
	"image_meta" jsonb,
	"origin" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_revisions_note_saved_idx" ON "note_revisions" USING btree ("note_id","saved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notes_tags_gin" ON "notes" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "notes_body_fts_gin" ON "notes" USING gin (to_tsvector('simple', "body"));--> statement-breakpoint
CREATE INDEX "notes_created_at_idx" ON "notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notes_updated_at_idx" ON "notes" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_image_sha256_live_uniq" ON "notes" USING btree (("image_meta" ->> 'sha256')) WHERE "notes"."image_meta" is not null and "notes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "notes_image_taken_at_idx" ON "notes" USING btree (("image_meta" ->> 'taken_at'));