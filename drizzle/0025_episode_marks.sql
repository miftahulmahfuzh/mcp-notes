CREATE TABLE "movie_episode_marks" (
	"title_id" text NOT NULL,
	"season" integer NOT NULL,
	"episode" integer NOT NULL,
	"watched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "movie_episode_marks_title_id_season_episode_pk" PRIMARY KEY("title_id","season","episode")
);
--> statement-breakpoint
ALTER TABLE "movie_titles" ADD COLUMN "not_interested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "movie_episode_marks" ADD CONSTRAINT "movie_episode_marks_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;