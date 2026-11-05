CREATE TABLE "cc_session_prompt_images" (
	"session_id" text NOT NULL,
	"prompt_seq" integer NOT NULL,
	"position" integer NOT NULL,
	"image_id" text NOT NULL,
	"paste_id" integer,
	CONSTRAINT "cc_session_prompt_images_session_id_prompt_seq_position_pk" PRIMARY KEY("session_id","prompt_seq","position")
);
--> statement-breakpoint
ALTER TABLE "cc_session_prompt_images" ADD CONSTRAINT "cc_session_prompt_images_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_session_prompt_images" ADD CONSTRAINT "cc_session_prompt_images_image_id_chat_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."chat_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_session_prompt_images" ADD CONSTRAINT "cc_session_prompt_images_session_id_prompt_seq_cc_session_prompts_session_id_seq_fk" FOREIGN KEY ("session_id","prompt_seq") REFERENCES "public"."cc_session_prompts"("session_id","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cc_session_prompt_images_image_idx" ON "cc_session_prompt_images" USING btree ("image_id");