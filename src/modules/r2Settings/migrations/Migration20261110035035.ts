import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261110035035 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "r2_setting_event" ("id" text not null, "action" text not null, "actor_id" text null, "actor_email" text null, "fields" jsonb null, "detail" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "r2_setting_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_r2_setting_event_deleted_at" ON "r2_setting_event" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "r2_setting" add column if not exists "public_url_template" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "r2_setting_event" cascade;`);

    this.addSql(`alter table if exists "r2_setting" drop column if exists "public_url_template";`);
  }

}
