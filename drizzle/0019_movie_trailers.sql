ALTER TABLE "movie_titles" ADD COLUMN "trailer_key" text;--> statement-breakpoint
ALTER TABLE "movie_titles" ADD COLUMN "season_trailers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "movie_titles" ADD COLUMN "trailers_checked_at" timestamp with time zone;