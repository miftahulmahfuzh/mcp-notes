CREATE TABLE "adversary_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"session_date" date NOT NULL,
	"symbol" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"verdict" jsonb,
	"prompt_version" text NOT NULL,
	"gather_model" text,
	"verdict_model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"error" text,
	"host" text NOT NULL,
	"reused_from" bigint,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "adversary_reviews_stage_check" CHECK ("adversary_reviews"."stage" in ('draft', 'final')),
	CONSTRAINT "adversary_reviews_status_check" CHECK ("adversary_reviews"."status" in ('ok', 'failed', 'skipped_budget', 'late'))
);
--> statement-breakpoint
ALTER TABLE "adversary_reviews" ADD CONSTRAINT "adversary_reviews_reused_from_adversary_reviews_id_fk" FOREIGN KEY ("reused_from") REFERENCES "public"."adversary_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adversary_reviews_started_idx" ON "adversary_reviews" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "adversary_reviews_key_idx" ON "adversary_reviews" USING btree ("strategy_id","session_date","symbol","started_at");