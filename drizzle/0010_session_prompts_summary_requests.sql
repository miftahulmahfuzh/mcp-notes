CREATE TABLE "cc_session_prompts" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone,
	"text" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "cc_session_prompts_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "summary_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "prompts_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_session_prompts" ADD CONSTRAINT "cc_session_prompts_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;