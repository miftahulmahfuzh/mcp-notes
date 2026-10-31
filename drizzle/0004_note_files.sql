CREATE TABLE "note_files" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"original_name" text NOT NULL,
	"host" text,
	"position" integer NOT NULL,
	"extracted_text" text,
	"extraction_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "note_files_extraction_status_check" CHECK (extraction_status in ('none', 'pending', 'done', 'failed', 'unsupported'))
);
--> statement-breakpoint
ALTER TABLE "note_files" ADD CONSTRAINT "note_files_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_files_path_uniq" ON "note_files" USING btree ("path");--> statement-breakpoint
CREATE INDEX "note_files_note_position_idx" ON "note_files" USING btree ("note_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "note_files_sha256_live_uniq" ON "note_files" USING btree ("sha256") WHERE "note_files"."deleted_at" is null;