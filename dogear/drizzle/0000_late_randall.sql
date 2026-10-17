CREATE TABLE `reading_bookmarks` (
	`owner_id` text NOT NULL,
	`url_key` text NOT NULL,
	`record` text,
	`updated_at` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`owner_id`, `url_key`),
	CONSTRAINT "reading_bookmarks_deleted_valid" CHECK("reading_bookmarks"."deleted" IN (0, 1)),
	CONSTRAINT "reading_bookmarks_record_state" CHECK(("reading_bookmarks"."deleted" = 1 AND "reading_bookmarks"."record" IS NULL) OR ("reading_bookmarks"."deleted" = 0 AND "reading_bookmarks"."record" IS NOT NULL))
);
