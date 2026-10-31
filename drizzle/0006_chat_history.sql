CREATE TABLE "chat_message_attachments" (
	"message_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	CONSTRAINT "chat_message_attachments_message_id_position_pk" PRIMARY KEY("message_id","position"),
	CONSTRAINT "chat_message_attachments_kind_check" CHECK ("chat_message_attachments"."kind" in ('chat_image', 'note_file', 'note_image'))
);
--> statement-breakpoint
CREATE TABLE "chat_message_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"text" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"brain" text,
	"reply_to" text,
	"seq" bigserial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chat_messages_role_check" CHECK ("chat_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "chat_messages_source_check" CHECK ("chat_messages"."source" in ('wall', 'claude_code'))
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"brain" text,
	"external_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_threads_source_check" CHECK ("chat_threads"."source" in ('wall', 'claude_code'))
);
--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_revisions" ADD CONSTRAINT "chat_message_revisions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_chat_messages_id_fk" FOREIGN KEY ("reply_to") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_message_attachments_ref_idx" ON "chat_message_attachments" USING btree ("kind","ref_id");--> statement-breakpoint
CREATE INDEX "chat_message_revisions_message_saved_idx" ON "chat_message_revisions" USING btree ("message_id","saved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_messages_timeline_idx" ON "chat_messages" USING btree ("created_at","seq");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id","created_at","seq");--> statement-breakpoint
CREATE INDEX "chat_messages_reply_to_idx" ON "chat_messages" USING btree ("reply_to");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_seq_uniq" ON "chat_messages" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_threads_external_key_uniq" ON "chat_threads" USING btree ("external_key");--> statement-breakpoint
CREATE INDEX "chat_threads_updated_at_idx" ON "chat_threads" USING btree ("updated_at");