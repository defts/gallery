import { Kysely, sql } from 'kysely';

// Trims move out of asset_edit into asset_video_trim, and asset.duration gets the original length back (the trim
// job had overwritten it with the trimmed file's). A trim stored without originalDuration (none are written today)
// keeps its current asset.duration, the only length known for it. Deleting the asset_edit rows clears
// asset."isEdited" through asset_edit_delete, so it is set again: the trimmed thumbnails are still the edited ones.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_video_trim" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "startTime" double precision NOT NULL,
  "endTime" double precision NOT NULL,
  "duration" integer,
  CONSTRAINT "asset_video_trim_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_video_trim_assetId_uq" UNIQUE ("assetId"),
  CONSTRAINT "asset_video_trim_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`
    INSERT INTO "asset_video_trim" ("id", "assetId", "startTime", "endTime", "duration")
    SELECT e."id",
           e."assetId",
           (e."parameters"->>'startTime')::double precision,
           (e."parameters"->>'endTime')::double precision,
           CASE
             WHEN a."duration" IS DISTINCT FROM round((e."parameters"->>'originalDuration')::double precision * 1000)
             THEN a."duration"
           END
      FROM "asset_edit" e
      JOIN "asset" a ON a."id" = e."assetId"
     WHERE e."action" = 'trim';
  `.execute(db);
  await sql`
    UPDATE "asset"
       SET "duration" = round((e."parameters"->>'originalDuration')::double precision * 1000)::integer
      FROM "asset_edit" e
     WHERE e."assetId" = "asset"."id"
       AND e."action" = 'trim'
       AND e."parameters" ? 'originalDuration'
       AND "asset"."duration" IS DISTINCT FROM round((e."parameters"->>'originalDuration')::double precision * 1000);
  `.execute(db);
  await sql`DELETE FROM "asset_edit" WHERE "action" = 'trim';`.execute(db);
  await sql`
    UPDATE "asset" SET "isEdited" = true
      FROM "asset_video_trim" t
     WHERE t."assetId" = "asset"."id" AND NOT "asset"."isEdited";
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    INSERT INTO "asset_edit" ("id", "assetId", "action", "parameters", "sequence")
    SELECT t."id",
           t."assetId",
           'trim',
           jsonb_build_object('startTime', t."startTime", 'endTime', t."endTime", 'originalDuration', a."duration" / 1000.0),
           0
      FROM "asset_video_trim" t
      JOIN "asset" a ON a."id" = t."assetId";
  `.execute(db);
  await sql`
    UPDATE "asset" SET "duration" = t."duration"
      FROM "asset_video_trim" t
     WHERE t."assetId" = "asset"."id" AND t."duration" IS NOT NULL;
  `.execute(db);
  await sql`DROP TABLE "asset_video_trim";`.execute(db);
}
