CREATE TABLE "note_images" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"taken_at" timestamp with time zone,
	"original_name" text,
	"host" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "note_images" ADD CONSTRAINT "note_images_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_images_path_uniq" ON "note_images" USING btree ("path");--> statement-breakpoint
CREATE INDEX "note_images_note_position_idx" ON "note_images" USING btree ("note_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "note_images_sha256_live_uniq" ON "note_images" USING btree ("sha256") WHERE "note_images"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "note_images_taken_at_idx" ON "note_images" USING btree ("taken_at");--> statement-breakpoint
insert into note_images (id, note_id, path, sha256, mime, width, height, bytes, taken_at, original_name, host, position, created_at, deleted_at)
select
  c.id,
  c.id,
  c.image_path,
  c.sha256,
  c.image_meta ->> 'mime',
  (c.image_meta ->> 'width')::integer,
  (c.image_meta ->> 'height')::integer,
  (c.image_meta ->> 'bytes')::integer,
  (c.image_meta ->> 'taken_at')::timestamptz,
  c.image_meta ->> 'original_name',
  c.image_meta ->> 'host',
  0,
  c.created_at,
  case
    when c.sha_rank = 1
      and not exists (
        select 1 from note_images l where l.sha256 = c.sha256 and l.deleted_at is null
      )
    then null
    else coalesce(c.deleted_at, now())
  end
from (
  select
    n.id,
    n.image_path,
    n.image_meta,
    n.image_meta ->> 'sha256' as sha256,
    n.created_at,
    n.deleted_at,
    row_number() over (
      partition by n.image_meta ->> 'sha256'
      order by n.deleted_at is not null, n.deleted_at desc, n.id
    ) as sha_rank
  from notes n
  where n.image_path is not null
    and n.image_meta is not null
    and not exists (select 1 from note_images i where i.id = n.id)
) c
on conflict do nothing;
