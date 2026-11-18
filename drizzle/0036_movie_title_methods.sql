CREATE TABLE "movie_genre_guides" (
	"title_id" text NOT NULL,
	"genre" text NOT NULL,
	"description" text NOT NULL,
	"items" jsonb NOT NULL,
	"model" text,
	"written_at" timestamp with time zone NOT NULL,
	CONSTRAINT "movie_genre_guides_title_id_genre_pk" PRIMARY KEY("title_id","genre")
);
--> statement-breakpoint
CREATE TABLE "movie_title_methods" (
	"title_id" text NOT NULL,
	"host" text NOT NULL,
	"method" text NOT NULL,
	"provider" text,
	"info_hash" text,
	"site_url" text,
	"season" integer,
	"episode" integer,
	"played_at" timestamp with time zone NOT NULL,
	CONSTRAINT "movie_title_methods_title_id_host_method_pk" PRIMARY KEY("title_id","host","method"),
	CONSTRAINT "movie_title_methods_slot_check" CHECK (("movie_title_methods"."season" is null) = ("movie_title_methods"."episode" is null))
);
--> statement-breakpoint
ALTER TABLE "movie_genre_guides" ADD CONSTRAINT "movie_genre_guides_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_title_methods" ADD CONSTRAINT "movie_title_methods_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every title starts with what its channel row remembers: the method it last played through.
INSERT INTO "movie_title_methods" ("title_id", "host", "method", "provider", "info_hash", "site_url", "season", "episode", "played_at")
SELECT c."title_id", c."host",
  CASE WHEN c."channel" = 'site' THEN c."provider" ELSE c."channel" END,
  CASE WHEN c."channel" = 'cloud' THEN c."provider" ELSE NULL END,
  c."info_hash", c."site_url", c."season", c."episode", c."played_at"
FROM "movie_title_channels" c
WHERE c."channel" IS NOT NULL AND c."played_at" IS NOT NULL AND (c."channel" <> 'site' OR c."provider" IS NOT NULL);
