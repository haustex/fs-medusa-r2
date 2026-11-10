import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261110020623 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "r2_setting" ("id" text not null, "account_id" text null, "jurisdiction" text not null default 'default', "endpoint" text null, "access_key_id_encrypted" text null, "access_key_id_hint" text null, "secret_access_key_encrypted" text null, "encryption_key_fingerprint" text null, "bucket" text null, "public_url" text null, "prefix" text not null default '', "private_bucket" text null, "cache_control" text not null default 'public, max-age=31536000, immutable', "download_url_ttl" integer not null default 3600, "upload_url_ttl" integer not null default 3600, "credentials_saved_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "r2_setting_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_r2_setting_deleted_at" ON "r2_setting" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "r2_setting" cascade;`);
  }

}
