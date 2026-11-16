CREATE TABLE "movie_dialogues" (
	"title_id" text NOT NULL,
	"season" integer NOT NULL,
	"episode" integer NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"provider" text NOT NULL,
	"cues" integer NOT NULL,
	"last_cue_s" integer NOT NULL,
	"body" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "movie_dialogues_title_id_season_episode_pk" PRIMARY KEY("title_id","season","episode"),
	CONSTRAINT "movie_dialogues_slot_check" CHECK ("movie_dialogues"."season" >= 0 and "movie_dialogues"."episode" >= 0 and ("movie_dialogues"."episode" > 0 or "movie_dialogues"."season" = 0))
);
--> statement-breakpoint
ALTER TABLE "movie_dialogues" ADD CONSTRAINT "movie_dialogues_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;