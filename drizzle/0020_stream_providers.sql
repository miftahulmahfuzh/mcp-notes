CREATE TABLE "stream_provider_health" (
	"name" text NOT NULL,
	"host" text NOT NULL,
	"last_outcome" text NOT NULL,
	"last_detail" text DEFAULT '' NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"recent_s" real[] DEFAULT '{}'::real[] NOT NULL,
	"manifest_kind" text,
	"best_height" integer,
	"en_subtitle" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_provider_health_name_host_pk" PRIMARY KEY("name","host"),
	CONSTRAINT "stream_provider_health_outcome_check" CHECK ("stream_provider_health"."last_outcome" in ('resolved', 'no_stream', 'bot_check', 'error')),
	CONSTRAINT "stream_provider_health_manifest_kind_check" CHECK ("stream_provider_health"."manifest_kind" in ('hls', 'dash', 'mp4'))
);
--> statement-breakpoint
CREATE TABLE "stream_providers" (
	"name" text PRIMARY KEY NOT NULL,
	"id_kind" text DEFAULT 'tmdb' NOT NULL,
	"movie" text NOT NULL,
	"tv" text,
	"browser_only" boolean DEFAULT false NOT NULL,
	"en_subtitle" boolean,
	"notes" text DEFAULT '' NOT NULL,
	"origin_site" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_providers_id_kind_check" CHECK ("stream_providers"."id_kind" in ('tmdb', 'imdb'))
);
--> statement-breakpoint
ALTER TABLE "stream_provider_health" ADD CONSTRAINT "stream_provider_health_name_stream_providers_name_fk" FOREIGN KEY ("name") REFERENCES "public"."stream_providers"("name") ON DELETE cascade ON UPDATE cascade;