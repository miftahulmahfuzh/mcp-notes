CREATE TABLE "movie_site_titles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"site" text NOT NULL,
	"site_url" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"year" integer,
	"poster_url" text,
	"overview" text DEFAULT '' NOT NULL,
	"country" text,
	"status" text,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"also_known" text,
	"season" integer,
	"episode" integer,
	"played_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_site_titles_kind_check" CHECK ("movie_site_titles"."kind" in ('movie', 'series')),
	CONSTRAINT "movie_site_titles_slot_check" CHECK (("movie_site_titles"."season" is null) = ("movie_site_titles"."episode" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "movie_site_titles_page_uniq" ON "movie_site_titles" USING btree ("host","site","site_url");