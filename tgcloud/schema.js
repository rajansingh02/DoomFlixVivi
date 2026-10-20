
import { table, integer, text, boolean, index, uniqueIndex, sql } from 'sdk/db';

// A series is searchable only after it has been published.
export const series = table('series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  normalizedTitle: text('normalized_title').notNull(),
  status: text('status').notNull(), // ongoing | finished
  published: boolean('published').default(false),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
}, (t) => ({
  titleIdx: index('idx_series_normalized_title').on(t.normalizedTitle),
  publishedIdx: index('idx_series_published').on(t.published),
}));

// One section represents a specific season at a specific quality.
export const sections = table('sections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  seriesId: integer('series_id').notNull(),
  seasonNumber: integer('season_number').notNull(),
  partNumber: integer('part_number').notNull().default(0),
  quality: text('quality').notNull(),
  published: boolean('published').default(false),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  seriesIdx: index('idx_sections_series').on(t.seriesId),
  legacyLookupIdx: uniqueIndex('uq_sections_series_season_quality')
    .on(
      t.seriesId,
      t.seasonNumber,
      t.quality,
    )
    .deprecated('replaced by unique season-part-quality index'),
  lookupIdx: uniqueIndex('uq_sections_series_season_part_quality').on(
    t.seriesId,
    t.seasonNumber,
    t.partNumber,
    t.quality,
  ),
}));

// Episode metadata and the corresponding post in the private vault.
export const episodes = table('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sectionId: integer('section_id').notNull(),
  sessionId: integer('session_id').notNull(),
  fileName: text('file_name').notNull(),
  episodeNumber: text('episode_number'),
  vaultChatId: text('vault_chat_id').notNull(),
  vaultMessageId: integer('vault_message_id').notNull(),
  uploadOrder: integer('upload_order').notNull(),
  published: boolean('published').default(false),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  sectionIdx: index('idx_episodes_section').on(t.sectionId),
  sessionIdx: index('idx_episodes_session').on(t.sessionId),
  deliveryIdx: index('idx_episodes_delivery').on(
    t.sectionId,
    t.published,
    t.uploadOrder,
  ),
}));

// Persistent owner workflow; it survives individual handler invocations.
export const uploadSessions = table('upload_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mode: text('mode').notNull(), // add | replace | append
  status: text('status').notNull(), // uploading | review | publishing | discarding | confirmed | discarded
  ownerUserId: integer('owner_user_id').notNull(),
  ownerChatId: integer('owner_chat_id').notNull(),
  seriesId: integer('series_id').notNull(),
  sectionId: integer('section_id').notNull(),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
}, (t) => ({
  ownerStatusIdx: index('idx_sessions_owner_status').on(
    t.ownerUserId,
    t.status,
  ),
  sectionStatusIdx: index('idx_sessions_section_status').on(
    t.sectionId,
    t.status,
  ),
}));


export const ownerDrafts = table('owner_drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerUserId: integer('owner_user_id').notNull(),
  ownerChatId: integer('owner_chat_id').notNull(),
  step: text('step').notNull(),
  title: text('title'),
  status: text('status'),
  seasonNumber: integer('season_number'),
  seriesId: integer('series_id'),
  sectionId: integer('section_id'),
  quality: text('quality'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
}, (t) => ({
  ownerUnique: uniqueIndex('uq_owner_drafts_owner').on(t.ownerUserId),
}));


export const deliveryJobs = table('delivery_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerUserId: integer('owner_user_id').notNull(),
  targetUserId: integer('target_user_id').notNull(),
  sectionId: integer('section_id').notNull(),
  mode: text('mode').notNull(), // all | latest
  status: text('status').notNull(), // pending | running | completed | failed
  lastEpisodeId: integer('last_episode_id'),
  retryAfterAt: integer('retry_after_at'),
  lockToken: text('lock_token'),
  lockExpiresAt: integer('lock_expires_at'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
}, (t) => ({
  ownerStatusIdx: index('idx_delivery_jobs_owner_status').on(
    t.ownerUserId,
    t.status,
  ),
  targetStatusIdx: index('idx_delivery_jobs_target_status').on(
    t.targetUserId,
    t.status,
  ),
}));


// One authorized Telegram group for public series search.
export const groupAuthorization = table('group_authorization', {
  id: integer('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  chatTitle: text('chat_title'),
  authorizedBy: integer('authorized_by').notNull(),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
});
