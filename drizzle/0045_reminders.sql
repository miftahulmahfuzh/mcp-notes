CREATE TABLE "reminders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seed_key" text,
	"body" text NOT NULL,
	"repo" text,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"last_shown_at" timestamp with time zone,
	CONSTRAINT "reminders_seed_key_unique" UNIQUE("seed_key"),
	CONSTRAINT "reminders_body_check" CHECK (length("reminders"."body") between 1 and 2000),
	CONSTRAINT "reminders_repo_check" CHECK ("reminders"."repo" is null or length("reminders"."repo") between 1 and 200),
	CONSTRAINT "reminders_seed_key_check" CHECK ("reminders"."seed_key" is null or length("reminders"."seed_key") between 1 and 100)
);
--> statement-breakpoint
CREATE INDEX "reminders_open_idx" ON "reminders" USING btree ("due_at") WHERE "reminders"."done_at" is null;