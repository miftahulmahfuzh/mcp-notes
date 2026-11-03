CREATE TABLE "note_session_links" (
	"note_id" text NOT NULL,
	"session_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_session_links_note_id_session_id_pk" PRIMARY KEY("note_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "note_session_links" ADD CONSTRAINT "note_session_links_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_session_links" ADD CONSTRAINT "note_session_links_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_session_links_session_idx" ON "note_session_links" USING btree ("session_id");