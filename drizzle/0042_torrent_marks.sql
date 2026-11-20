CREATE TABLE "stream_torrent_marks" (
	"info_hash" text PRIMARY KEY NOT NULL,
	"name" text,
	"tag_languages" jsonb,
	"heard_language" text,
	"heard_probability" real,
	"heard_at" timestamp with time zone,
	"blacklisted_at" timestamp with time zone,
	"blacklist_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_torrent_marks_info_hash_check" CHECK ("stream_torrent_marks"."info_hash" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "stream_torrent_marks_heard_check" CHECK (("stream_torrent_marks"."heard_language" is null) = ("stream_torrent_marks"."heard_at" is null)),
	CONSTRAINT "stream_torrent_marks_reason_check" CHECK ("stream_torrent_marks"."blacklisted_at" is not null or "stream_torrent_marks"."blacklist_reason" is null)
);
