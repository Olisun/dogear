import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const readingBookmarks = sqliteTable('reading_bookmarks', {
  ownerId: text('owner_id').notNull(),
  urlKey: text('url_key').notNull(),
  record: text('record', { mode: 'json' }),
  updatedAt: integer('updated_at').notNull(),
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
}, table => [
  primaryKey({ columns: [table.ownerId, table.urlKey] }),
  check('reading_bookmarks_deleted_valid', sql`${table.deleted} IN (0, 1)`),
  check('reading_bookmarks_record_state', sql`(${table.deleted} = 1 AND ${table.record} IS NULL) OR (${table.deleted} = 0 AND ${table.record} IS NOT NULL)`),
]);
