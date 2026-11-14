-- Movie ids: the id the owner types and reads for a title or an episode, `M-23T4`.
-- movie_next_id() scrambles a sequence over the 36^4 = 1,679,616 ids (741457 shares no factor with
-- 36^4 = 2^8 * 3^8, so n -> n * 741457 + 250007 mod 36^4 never repeats before the sequence wraps),
-- so ids look random, need no retry and are the same from either machine.
CREATE SEQUENCE "movie_id_seq" AS bigint MINVALUE 0 START WITH 0;
--> statement-breakpoint
CREATE FUNCTION movie_next_id() RETURNS text
LANGUAGE sql VOLATILE
AS $$
  SELECT 'M-' || string_agg(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', ((v / p) % 36)::int + 1, 1), '' ORDER BY p DESC)
  FROM (SELECT (nextval('movie_id_seq') * 741457 + 250007) % 1679616 AS v) n,
       unnest(ARRAY[1, 36, 1296, 46656]::bigint[]) AS p
$$;
--> statement-breakpoint
CREATE TABLE "movie_ids" (
	"id" text PRIMARY KEY DEFAULT movie_next_id() NOT NULL,
	"title_id" text NOT NULL,
	"season" integer,
	"episode" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_ids_target_unique" UNIQUE NULLS NOT DISTINCT("title_id","season","episode"),
	CONSTRAINT "movie_ids_id_format" CHECK ("movie_ids"."id" ~ '^M-[0-9A-Z]{4}$'),
	CONSTRAINT "movie_ids_target_shape" CHECK (("movie_ids"."season" is null) = ("movie_ids"."episode" is null))
);
--> statement-breakpoint
ALTER TABLE "movie_ids" ADD CONSTRAINT "movie_ids_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Every title, every episode row and every (season, episode) a file names gets its id here, whoever
-- wrote the row. WHERE NOT EXISTS keeps the sequence for rows that are really new (upsertTitle
-- re-inserts every episode row on a metadata refresh); ON CONFLICT covers two writers at once.
CREATE FUNCTION movie_ids_register() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'movie_titles' THEN
    INSERT INTO movie_ids (title_id)
    SELECT NEW.id
    WHERE NOT EXISTS (SELECT 1 FROM movie_ids m WHERE m.title_id = NEW.id AND m.season IS NULL)
    ON CONFLICT (title_id, season, episode) DO NOTHING;
  ELSIF NEW.title_id IS NOT NULL AND NEW.season IS NOT NULL AND NEW.episode IS NOT NULL THEN
    INSERT INTO movie_ids (title_id, season, episode)
    SELECT NEW.title_id, NEW.season, NEW.episode
    WHERE NOT EXISTS (SELECT 1 FROM movie_ids m WHERE m.title_id = NEW.title_id AND m.season = NEW.season AND m.episode = NEW.episode)
    ON CONFLICT (title_id, season, episode) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "movie_titles_register_id" AFTER INSERT ON "movie_titles" FOR EACH ROW EXECUTE FUNCTION movie_ids_register();
--> statement-breakpoint
CREATE TRIGGER "movie_episodes_register_id" AFTER INSERT ON "movie_episodes" FOR EACH ROW EXECUTE FUNCTION movie_ids_register();
--> statement-breakpoint
CREATE TRIGGER "movie_files_register_id" AFTER INSERT OR UPDATE OF "title_id", "season", "episode" ON "movie_files" FOR EACH ROW EXECUTE FUNCTION movie_ids_register();
--> statement-breakpoint
-- Tag what is already in the registry: titles, then their episodes in order, then file-only episodes.
INSERT INTO "movie_ids" ("title_id")
SELECT "id" FROM "movie_titles" ORDER BY "created_at", "id";
--> statement-breakpoint
INSERT INTO "movie_ids" ("title_id", "season", "episode")
SELECT "title_id", "season", "episode" FROM "movie_episodes" ORDER BY "title_id", "season", "episode";
--> statement-breakpoint
INSERT INTO "movie_ids" ("title_id", "season", "episode")
SELECT DISTINCT f."title_id", f."season", f."episode" FROM "movie_files" f
WHERE f."title_id" IS NOT NULL AND f."season" IS NOT NULL AND f."episode" IS NOT NULL
ON CONFLICT ("title_id", "season", "episode") DO NOTHING;
