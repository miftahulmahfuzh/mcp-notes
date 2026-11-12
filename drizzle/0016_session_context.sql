ALTER TABLE "cc_sessions" ADD COLUMN "context_tokens" bigint;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_model" text;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_peak_tokens" bigint;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_first_tokens" bigint;--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "context_long_beta" boolean DEFAULT false NOT NULL;