CREATE TABLE "movie_title_channels" (
	"title_id" text NOT NULL,
	"host" text NOT NULL,
	"channel" text,
	"provider" text,
	"info_hash" text,
	"site_url" text,
	"season" integer,
	"episode" integer,
	"played_at" timestamp with time zone,
	"cloud_failed_at" timestamp with time zone,
	"torrent_failed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_title_channels_title_id_host_pk" PRIMARY KEY("title_id","host"),
	CONSTRAINT "movie_title_channels_channel_check" CHECK ("movie_title_channels"."channel" is null or "movie_title_channels"."channel" in ('cloud', 'torrent', 'site')),
	CONSTRAINT "movie_title_channels_played_check" CHECK (("movie_title_channels"."channel" is null) = ("movie_title_channels"."played_at" is null)),
	CONSTRAINT "movie_title_channels_detail_check" CHECK (("movie_title_channels"."channel" is distinct from 'torrent' or "movie_title_channels"."provider" is null)
        and ("movie_title_channels"."channel" is not distinct from 'torrent' or "movie_title_channels"."info_hash" is null)
        and ("movie_title_channels"."channel" is not distinct from 'site' or "movie_title_channels"."site_url" is null)
        and ("movie_title_channels"."channel" is null or "movie_title_channels"."channel" = 'torrent' or "movie_title_channels"."provider" is not null)
        and ("movie_title_channels"."channel" is distinct from 'site' or "movie_title_channels"."site_url" is not null)
        and ("movie_title_channels"."season" is null) = ("movie_title_channels"."episode" is null))
);
--> statement-breakpoint
ALTER TABLE "movie_title_channels" ADD CONSTRAINT "movie_title_channels_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every title streamed before this table existed starts with the channel of its last stream play.
INSERT INTO "movie_title_channels" ("title_id", "host", "channel", "provider", "season", "episode", "played_at", "updated_at")
SELECT DISTINCT ON (p."title_id", p."host")
  p."title_id", p."host",
  CASE WHEN p."provider" = 'Torrent' THEN 'torrent' ELSE 'cloud' END,
  CASE WHEN p."provider" = 'Torrent' THEN NULL ELSE p."provider" END,
  p."season", p."episode", p."started_at", now()
FROM "movie_plays" p
WHERE p."source" = 'stream' AND p."title_id" IS NOT NULL AND p."provider" IS NOT NULL
ORDER BY p."title_id", p."host", p."started_at" DESC, p."id" DESC;
