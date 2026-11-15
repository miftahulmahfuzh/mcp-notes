CREATE TABLE "stream_probe_titles" (
	"host" text NOT NULL,
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"list_source" text,
	"list_rank" integer,
	"listed_at" timestamp with time zone,
	"probed_at" timestamp with time zone,
	"outcome" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	CONSTRAINT "stream_probe_titles_host_kind_tmdb_id_pk" PRIMARY KEY("host","kind","tmdb_id"),
	CONSTRAINT "stream_probe_titles_kind_check" CHECK ("stream_probe_titles"."kind" in ('movie', 'tv')),
	CONSTRAINT "stream_probe_titles_tmdb_id_check" CHECK ("stream_probe_titles"."tmdb_id" > 0),
	CONSTRAINT "stream_probe_titles_source_check" CHECK ("stream_probe_titles"."list_source" is null or "stream_probe_titles"."list_source" in ('recommended', 'genre', 'trending', 'popular')),
	CONSTRAINT "stream_probe_titles_listed_check" CHECK (("stream_probe_titles"."list_source" is null) = ("stream_probe_titles"."list_rank" is null) and ("stream_probe_titles"."list_source" is null) = ("stream_probe_titles"."listed_at" is null)),
	CONSTRAINT "stream_probe_titles_outcome_check" CHECK (("stream_probe_titles"."outcome" is null) = ("stream_probe_titles"."probed_at" is null) and ("stream_probe_titles"."outcome" is null or "stream_probe_titles"."outcome" in ('verified', 'no_source', 'error'))),
	CONSTRAINT "stream_probe_titles_backoff_check" CHECK ("stream_probe_titles"."failures" >= 0 and ("stream_probe_titles"."outcome" is null or ("stream_probe_titles"."outcome" = 'verified' and "stream_probe_titles"."failures" = 0 and "stream_probe_titles"."retry_after" is null) or ("stream_probe_titles"."outcome" <> 'verified' and "stream_probe_titles"."failures" > 0 and "stream_probe_titles"."retry_after" is not null)))
);
--> statement-breakpoint
CREATE INDEX "stream_probe_titles_listed_idx" ON "stream_probe_titles" USING btree ("host","kind","list_rank");