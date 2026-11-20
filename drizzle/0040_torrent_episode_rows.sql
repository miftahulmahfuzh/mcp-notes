-- One row per host, info hash and episode: a season pack keeps a row (its files, its state, its play) for every
-- episode chosen from it. Every existing row is one episode's (or a film's) already, so it stays as it is.
ALTER TABLE "stream_torrents" DROP CONSTRAINT "stream_torrents_host_info_hash_pk";--> statement-breakpoint
ALTER TABLE "stream_torrents" ADD CONSTRAINT "stream_torrents_host_info_hash_season_episode_pk" PRIMARY KEY("host","info_hash","season","episode");
