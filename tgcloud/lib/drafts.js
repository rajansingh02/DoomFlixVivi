
import { db } from 'sdk';
import { and, eq } from 'sdk/db';
import { ownerDrafts } from '../schema.js';

const VALID_STEPS = [
  'title',
  'status',
  'season',
  'quality',
  'part_choice',
  'part_identifier',
  'part_upload',
  'part_wait',
  'edit_title',
  'sinfo_title',
  'sinfo_status',
  'edit_action',
  'edit_add_season',
  'edit_add_quality',
  'edit_add_episode_quality',
];

export async function getOwnerDraft(ownerUserId) {
  return await db
    .select()
    .from(ownerDrafts)
    .where(eq(ownerDrafts.ownerUserId, ownerUserId))
    .get();
}

export async function startOwnerDraft(ownerUserId, ownerChatId) {
  if (
    !Number.isSafeInteger(ownerUserId) ||
    !Number.isSafeInteger(ownerChatId) ||
    ownerUserId < 1
  ) {
    throw new Error('Invalid owner or chat ID.');
  }

  const existing = await getOwnerDraft(ownerUserId);

  if (existing) {
    throw new Error(
      'An owner workflow is already in progress. Finish it or cancel it before starting another.',
    );
  }

  const [draft] = await db
    .insert(ownerDrafts)
    .values({
      ownerUserId,
      ownerChatId,
      step: 'title',
    })
    .returning()
    .run();

  return draft;
}

export async function updateOwnerDraft(ownerUserId, changes) {
  const draft = await getOwnerDraft(ownerUserId);

  if (!draft) {
    throw new Error('No active series draft was found.');
  }

  if (changes.step && !VALID_STEPS.includes(changes.step)) {
    throw new Error('Invalid draft step.');
  }

  const allowedFields = [
    'step',
    'title',
    'status',
    'seasonNumber',
    'seriesId',
    'sectionId',
    'quality',
  ];

  const update = {};

  for (const field of allowedFields) {
    if (Object.hasOwn(changes, field)) {
      update[field] = changes[field];
    }
  }

  if (Object.keys(update).length === 0) {
    return draft;
  }

  update.updatedAt = Math.floor(Date.now() / 1000);

  await db
    .update(ownerDrafts)
    .set(update)
    .where(
      and(
        eq(ownerDrafts.id, draft.id),
        eq(ownerDrafts.ownerUserId, ownerUserId),
      ),
    )
    .run();

  return await getOwnerDraft(ownerUserId);
}

export async function clearOwnerDraft(ownerUserId) {
  await db
    .delete(ownerDrafts)
    .where(eq(ownerDrafts.ownerUserId, ownerUserId))
    .run();
}
