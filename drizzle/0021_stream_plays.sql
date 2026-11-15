CREATE TABLE "movie_stream_sources" (
	"title_id" text NOT NULL,
	"season" integer NOT NULL,
	"episode" integer NOT NULL,
	"host" text NOT NULL,
	"provider" text,
	"manifest_kind" text,
	"best_height" integer,
	"en_subtitle" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"failure" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_stream_sources_title_id_season_episode_host_pk" PRIMARY KEY("title_id","season","episode","host"),
	CONSTRAINT "movie_stream_sources_slot_check" CHECK ("movie_stream_sources"."season" >= 0 and "movie_stream_sources"."episode" >= 0 and ("movie_stream_sources"."episode" > 0 or "movie_stream_sources"."season" = 0)),
	CONSTRAINT "movie_stream_sources_outcome_check" CHECK (("movie_stream_sources"."verified_at" is not null and "movie_stream_sources"."provider" is not null and "movie_stream_sources"."manifest_kind" is not null)
        or ("movie_stream_sources"."verified_at" is null and "movie_stream_sources"."stale_at" is not null and "movie_stream_sources"."provider" is null and "movie_stream_sources"."manifest_kind" is null and "movie_stream_sources"."best_height" is null)),
	CONSTRAINT "movie_stream_sources_failure_check" CHECK (("movie_stream_sources"."stale_at" is null) = ("movie_stream_sources"."failure" is null))
);
--> statement-breakpoint
ALTER TABLE "movie_plays" DROP CONSTRAINT "movie_plays_source_check";--> statement-breakpoint
ALTER TABLE "movie_plays" ALTER COLUMN "file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "movie_plays" ADD COLUMN "title_id" text;--> statement-breakpoint
ALTER TABLE "movie_plays" ADD COLUMN "season" integer;--> statement-breakpoint
ALTER TABLE "movie_plays" ADD COLUMN "episode" integer;--> statement-breakpoint
ALTER TABLE "movie_plays" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "movie_plays" ADD COLUMN "stream_session" text;--> statement-breakpoint
ALTER TABLE "movie_stream_sources" ADD CONSTRAINT "movie_stream_sources_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movie_stream_sources_host_verified_idx" ON "movie_stream_sources" USING btree ("host","verified_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "movie_plays" ADD CONSTRAINT "movie_plays_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movie_plays_title_started_idx" ON "movie_plays" USING btree ("title_id","started_at" DESC NULLS LAST) WHERE "movie_plays"."title_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "movie_plays_open_session_uniq" ON "movie_plays" USING btree ("stream_session") WHERE "movie_plays"."ended_at" is null and "movie_plays"."stream_session" is not null;--> statement-breakpoint
ALTER TABLE "movie_plays" ADD CONSTRAINT "movie_plays_target_check" CHECK (("movie_plays"."source" = 'stream' and "movie_plays"."file_id" is null and "movie_plays"."title_id" is not null and "movie_plays"."provider" is not null and "movie_plays"."stream_session" is not null and ("movie_plays"."season" is null) = ("movie_plays"."episode" is null))
        or ("movie_plays"."source" <> 'stream' and "movie_plays"."file_id" is not null and "movie_plays"."title_id" is null and "movie_plays"."season" is null and "movie_plays"."episode" is null and "movie_plays"."provider" is null and "movie_plays"."stream_session" is null));--> statement-breakpoint
ALTER TABLE "movie_plays" ADD CONSTRAINT "movie_plays_source_check" CHECK ("movie_plays"."source" in ('live', 'vlc_recents', 'stream'));--> statement-breakpoint
-- A streamed episode gets its movie id like a file's episode does (0018's movie_ids_register, generic
-- branch). A file play has title_id null, so the trigger does nothing for it. Not on
-- movie_stream_sources: its film rows are season 0, episode 0, which is not an episode.
CREATE TRIGGER "movie_plays_register_id" AFTER INSERT ON "movie_plays" FOR EACH ROW EXECUTE FUNCTION movie_ids_register();
