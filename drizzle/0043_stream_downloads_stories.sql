CREATE TABLE "movie_stories" (
	"title_id" text NOT NULL,
	"season" integer NOT NULL,
	"episode" integer NOT NULL,
	"text" text NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"model" text,
	"written_at" timestamp with time zone NOT NULL,
	CONSTRAINT "movie_stories_title_id_season_episode_pk" PRIMARY KEY("title_id","season","episode"),
	CONSTRAINT "movie_stories_slot_check" CHECK ("movie_stories"."season" >= 0 and "movie_stories"."episode" >= 0),
	CONSTRAINT "movie_stories_origin_check" CHECK ("movie_stories"."origin" in ('web', 'dialogue')),
	CONSTRAINT "movie_stories_lists_check" CHECK (jsonb_typeof("movie_stories"."sections") = 'array' and jsonb_typeof("movie_stories"."sources") = 'array')
);
--> statement-breakpoint
CREATE TABLE "stream_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"season" integer DEFAULT 0 NOT NULL,
	"episode" integer DEFAULT 0 NOT NULL,
	"via" text DEFAULT 'auto' NOT NULL,
	"info_hash" text,
	"batch" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"source" text,
	"source_id" text,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"bytes_total" bigint,
	"error" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "stream_downloads_kind_check" CHECK ("stream_downloads"."kind" in ('movie', 'tv')),
	CONSTRAINT "stream_downloads_slot_check" CHECK ("stream_downloads"."tmdb_id" > 0 and (("stream_downloads"."kind" = 'movie' and "stream_downloads"."season" = 0 and "stream_downloads"."episode" = 0) or ("stream_downloads"."kind" = 'tv' and "stream_downloads"."season" >= 0 and "stream_downloads"."episode" > 0))),
	CONSTRAINT "stream_downloads_via_check" CHECK ("stream_downloads"."via" in ('auto', 'torrent', 'cloud')),
	CONSTRAINT "stream_downloads_state_check" CHECK ("stream_downloads"."state" in ('queued', 'running', 'paused', 'done', 'failed')),
	CONSTRAINT "stream_downloads_info_hash_check" CHECK ("stream_downloads"."info_hash" is null or ("stream_downloads"."via" = 'torrent' and "stream_downloads"."info_hash" ~ '^[0-9a-f]{40}$')),
	CONSTRAINT "stream_downloads_source_check" CHECK (("stream_downloads"."source" is null) = ("stream_downloads"."source_id" is null) and ("stream_downloads"."source" is null or "stream_downloads"."source" in ('torrent', 'cloud')) and ("stream_downloads"."source" is distinct from 'torrent' or "stream_downloads"."source_id" ~ '^[0-9a-f]{40}$')),
	CONSTRAINT "stream_downloads_failed_check" CHECK (("stream_downloads"."state" = 'failed') = ("stream_downloads"."error" is not null)),
	CONSTRAINT "stream_downloads_done_check" CHECK (("stream_downloads"."state" = 'done') = ("stream_downloads"."completed_at" is not null) and ("stream_downloads"."state" <> 'done' or "stream_downloads"."source" is not null)),
	CONSTRAINT "stream_downloads_counts_check" CHECK ("stream_downloads"."bytes_done" >= 0 and ("stream_downloads"."bytes_total" is null or "stream_downloads"."bytes_total" >= 0))
);
--> statement-breakpoint
ALTER TABLE "stream_torrents" ADD COLUMN "kept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "movie_stories" ADD CONSTRAINT "movie_stories_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stream_downloads_open_slot_idx" ON "stream_downloads" USING btree ("host","kind","tmdb_id","season","episode") WHERE "stream_downloads"."state" <> 'done';--> statement-breakpoint
CREATE INDEX "stream_downloads_host_state_idx" ON "stream_downloads" USING btree ("host","state","created_at");
--> statement-breakpoint
-- Every story written so far was written from a dialogue and kept on its row. Stories live in movie_stories from now
-- on; the old columns stay as they are, unread, so nothing is lost.
INSERT INTO "movie_stories" ("title_id", "season", "episode", "text", "origin", "model", "written_at")
SELECT d."title_id", d."season", d."episode", d."story", 'dialogue', d."story_model", coalesce(d."story_at", d."fetched_at")
FROM "movie_dialogues" d
WHERE d."story" IS NOT NULL;
