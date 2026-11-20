ALTER TABLE "stream_trending" DROP CONSTRAINT "stream_trending_probe_check";--> statement-breakpoint
ALTER TABLE "stream_trending" DROP COLUMN "probe_outcome";--> statement-breakpoint
ALTER TABLE "stream_trending" DROP COLUMN "probe_detail";--> statement-breakpoint
ALTER TABLE "stream_trending" DROP COLUMN "probed_at";