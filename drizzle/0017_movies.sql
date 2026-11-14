CREATE TABLE "movie_companies" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"logo_path" text,
	"origin_country" text
);
--> statement-breakpoint
CREATE TABLE "movie_credits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"title_id" text NOT NULL,
	"person_id" integer NOT NULL,
	"role" text NOT NULL,
	"character" text,
	"job" text,
	"ord" integer NOT NULL,
	CONSTRAINT "movie_credits_role_check" CHECK ("movie_credits"."role" in ('cast', 'director', 'writer', 'producer', 'creator'))
);
--> statement-breakpoint
CREATE TABLE "movie_episodes" (
	"title_id" text NOT NULL,
	"season" integer NOT NULL,
	"episode" integer NOT NULL,
	"name" text NOT NULL,
	"air_date" date,
	"runtime_min" integer,
	"overview" text,
	"still_path" text,
	CONSTRAINT "movie_episodes_title_id_season_episode_pk" PRIMARY KEY("title_id","season","episode")
);
--> statement-breakpoint
CREATE TABLE "movie_files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"title_id" text,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint,
	"mtime" timestamp with time zone,
	"duration_s" real,
	"season" integer,
	"episode" integer,
	"absolute_episode" integer,
	"status" text NOT NULL,
	"reason" text,
	"parsed" jsonb,
	"source" text DEFAULT 'scan' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"moved_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"watched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_files_status_check" CHECK ("movie_files"."status" in ('matched', 'unmatched', 'pending')),
	CONSTRAINT "movie_files_source_check" CHECK ("movie_files"."source" in ('scan', 'vlc_recents')),
	CONSTRAINT "movie_files_match_check" CHECK (("movie_files"."status" = 'matched' and "movie_files"."title_id" is not null and "movie_files"."reason" is null) or ("movie_files"."status" <> 'matched' and "movie_files"."title_id" is null))
);
--> statement-breakpoint
CREATE TABLE "movie_people" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"profile_path" text
);
--> statement-breakpoint
CREATE TABLE "movie_plays" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"file_id" bigint NOT NULL,
	"host" text NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"start_position_s" real,
	"position_s" real,
	"duration_s" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_plays_source_check" CHECK ("movie_plays"."source" in ('live', 'vlc_recents'))
);
--> statement-breakpoint
CREATE TABLE "movie_title_companies" (
	"title_id" text NOT NULL,
	"company_id" integer NOT NULL,
	"ord" integer NOT NULL,
	CONSTRAINT "movie_title_companies_title_id_company_id_pk" PRIMARY KEY("title_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "movie_titles" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"title" text NOT NULL,
	"original_title" text NOT NULL,
	"year" integer,
	"release_date" date,
	"overview" text DEFAULT '' NOT NULL,
	"poster_path" text,
	"backdrop_path" text,
	"runtime_min" integer,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"season_count" integer,
	"episode_count" integer,
	"watched_at" timestamp with time zone,
	"rating" smallint,
	"review_note_id" text,
	"metadata_fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("original_title", '') || ' ' || coalesce("overview", ''))) STORED,
	CONSTRAINT "movie_titles_kind_check" CHECK ("movie_titles"."kind" in ('movie', 'tv')),
	CONSTRAINT "movie_titles_tmdb_id_check" CHECK ("movie_titles"."tmdb_id" > 0),
	CONSTRAINT "movie_titles_id_check" CHECK ("movie_titles"."id" = "movie_titles"."kind" || '-' || "movie_titles"."tmdb_id"::text),
	CONSTRAINT "movie_titles_rating_check" CHECK ("movie_titles"."rating" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "movie_credits" ADD CONSTRAINT "movie_credits_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_credits" ADD CONSTRAINT "movie_credits_person_id_movie_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."movie_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_episodes" ADD CONSTRAINT "movie_episodes_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_files" ADD CONSTRAINT "movie_files_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_plays" ADD CONSTRAINT "movie_plays_file_id_movie_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."movie_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_title_companies" ADD CONSTRAINT "movie_title_companies_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_title_companies" ADD CONSTRAINT "movie_title_companies_company_id_movie_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."movie_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_titles" ADD CONSTRAINT "movie_titles_review_note_id_notes_id_fk" FOREIGN KEY ("review_note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movie_credits_person_idx" ON "movie_credits" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "movie_credits_title_role_idx" ON "movie_credits" USING btree ("title_id","role","ord");--> statement-breakpoint
CREATE UNIQUE INDEX "movie_files_live_path_uniq" ON "movie_files" USING btree ("host","path") WHERE "movie_files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "movie_files_title_idx" ON "movie_files" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "movie_files_name_size_idx" ON "movie_files" USING btree ("host","name","size");--> statement-breakpoint
CREATE INDEX "movie_plays_file_started_idx" ON "movie_plays" USING btree ("file_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "movie_plays_started_idx" ON "movie_plays" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "movie_title_companies_company_idx" ON "movie_title_companies" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "movie_titles_kind_tmdb_uniq" ON "movie_titles" USING btree ("kind","tmdb_id");--> statement-breakpoint
CREATE INDEX "movie_titles_search_gin" ON "movie_titles" USING gin ("search_tsv");