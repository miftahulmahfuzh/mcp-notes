ALTER TABLE "cc_sessions" DROP CONSTRAINT "cc_sessions_parent_link_source_check";--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "head_uuid" text;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "fork_cut_offset" bigint;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "forked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "fork_prompt_count" integer;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "fork_detected_by" text;--> statement-breakpoint
CREATE INDEX "cc_sessions_host_head_uuid_idx" ON "cc_sessions" USING btree ("host","head_uuid");--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD CONSTRAINT "cc_sessions_fork_detected_by_check" CHECK ("cc_sessions"."fork_detected_by" in ('job', 'uuid', 'time'));--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD CONSTRAINT "cc_sessions_fork_info_check" CHECK (("cc_sessions"."fork_detected_by" is null) = ("cc_sessions"."fork_cut_offset" is null) and ("cc_sessions"."fork_detected_by" is null) = ("cc_sessions"."fork_prompt_count" is null));--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD CONSTRAINT "cc_sessions_parent_link_source_check" CHECK ("cc_sessions"."parent_link_source" in ('fork', 'env', 'hook', 'heuristic'));