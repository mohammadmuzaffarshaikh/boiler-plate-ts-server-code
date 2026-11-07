-- Upload destination folder.
--
-- Added because the key prefix was previously decided by an endpoint-side
-- constant ("products" / "documents") with no way for a caller to say where
-- a file belongs, and no way to query for it afterwards. The folder is now
-- a request field, validated against a closed allowlist, and recorded so
-- `GET /api/app/files?folder=product_images` does not have to pattern-match
-- the key column.
--
-- Backfilled rather than defaulted, in three steps, so no row is left with a
-- folder that contradicts its key. The old prefixes were "products/" for
-- images and videos together and "documents/" for the rest; videos are told
-- apart by their recorded mime type. The DEFAULT is dropped afterwards on
-- purpose: every insert must state the folder, and a column default would
-- quietly absorb the day someone forgets.
ALTER TABLE "files" ADD COLUMN "folder" TEXT;

UPDATE "files"
SET "folder" = CASE
  WHEN "key" LIKE 'documents/%'   THEN 'documents'
  WHEN "mime_type" LIKE 'video/%' THEN 'product_videos'
  ELSE 'product_images'
END
WHERE "folder" IS NULL;

ALTER TABLE "files" ALTER COLUMN "folder" SET NOT NULL;

CREATE INDEX "files_folder_status_created_at_idx"
  ON "files"("folder", "status", "created_at");
