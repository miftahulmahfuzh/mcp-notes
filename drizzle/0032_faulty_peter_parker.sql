CREATE TABLE "stream_trending" (
	"host" text NOT NULL,
	"title_id" text NOT NULL,
	"kind" text NOT NULL,
	"imdb_id" text NOT NULL,
	"rank" integer NOT NULL,
	"seeds" integer NOT NULL,
	"index" text NOT NULL,
	"info_hash" text NOT NULL,
	"release_name" text NOT NULL,
	"size_bytes" bigint,
	"listed_at" timestamp with time zone NOT NULL,
	"probe_outcome" text,
	"probe_detail" text,
	"probed_at" timestamp with time zone,
	CONSTRAINT "stream_trending_host_title_id_pk" PRIMARY KEY("host","title_id"),
	CONSTRAINT "stream_trending_kind_check" CHECK ("stream_trending"."kind" in ('movie', 'tv')),
	CONSTRAINT "stream_trending_seeds_check" CHECK ("stream_trending"."seeds" >= 0 and "stream_trending"."rank" > 0),
	CONSTRAINT "stream_trending_probe_check" CHECK (("stream_trending"."probe_outcome" is null) = ("stream_trending"."probed_at" is null) and ("stream_trending"."probe_outcome" is null or "stream_trending"."probe_outcome" in ('confirmed', 'no_peers', 'no_video', 'error')))
);
--> statement-breakpoint
ALTER TABLE "stream_trending" ADD CONSTRAINT "stream_trending_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stream_trending_rank_idx" ON "stream_trending" USING btree ("host","kind","rank");