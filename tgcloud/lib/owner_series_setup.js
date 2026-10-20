
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { series, sections } from '../schema.js';
import { normalizeTitle } from './catalog.js';
import {
  getOwnerDraft,
  updateOwnerDraft,
  clearOwnerDraft,
} from './drafts.js';
import {
  createUploadSession,
  findBlockingUploadSession,
} from './sessions.js';

export async function prepareNewSeriesUpload(ownerUserId, ownerChatId) {
  const draft = await getOwnerDraft(ownerUserId);

  if (!draft || draft.ownerChatId !== ownerChatId) {
    throw new Error('No matching owner draft was found.');
  }

  if (
    !['quality', 'part_choice'].includes(draft.step) ||
    !draft.title ||
    !draft.status ||
    !Number.isSafeInteger(draft.seasonNumber) ||
    !draft.quality
  ) {
    throw new Error('The series details are incomplete.');
  }

  const normalizedTitle = normalizeTitle(draft.title);

  const existingSeries = await db
    .select()
    .from(series)
    .where(eq(series.normalizedTitle, normalizedTitle))
    .all();

  if (existingSeries.length > 0) {
    throw new Error(
      'A series with this title already exists. Use the edit workflow for existing series.',
    );
  }

  const blockingSession = await findBlockingUploadSession(ownerUserId);

  if (blockingSession) {
    throw new Error(
      'You already have an upload in progress or awaiting review. Finish or discard it first.',
    );
  }

  let seriesRecord = null;
  let section = null;
  let session = null;

  try {
    [seriesRecord] = await db
      .insert(series)
      .values({
        title: draft.title,
        normalizedTitle,
        status: draft.status,
        published: false,
      })
      .returning()
      .run();

    [section] = await db
      .insert(sections)
      .values({
        seriesId: seriesRecord.id,
        seasonNumber: draft.seasonNumber,
        quality: draft.quality,
        published: false,
      })
      .returning()
      .run();

    session = await createUploadSession({
      mode: 'add',
      ownerUserId,
      ownerChatId,
      seriesId: seriesRecord.id,
      sectionId: section.id,
    });
  } catch (error) {
    // Only clean up setup records if no upload session was created.
    if (!session) {
      if (section) {
        try {
          await db
            .delete(sections)
            .where(eq(sections.id, section.id))
            .run();
        } catch {
          // Preserve the original error; cleanup may need manual recovery.
        }
      }

      if (seriesRecord) {
        try {
          await db
            .delete(series)
            .where(eq(series.id, seriesRecord.id))
            .run();
        } catch {
          // Preserve the original error; cleanup may need manual recovery.
        }
      }
    }

    throw error;
  }

  let draftCleanupWarning = false;

  try {
    await clearOwnerDraft(ownerUserId);
  } catch {
    // The upload session exists, so preserve it and do not roll back its records.
    draftCleanupWarning = true;
  }

  return {
    series: seriesRecord,
    section,
    session,
    draftCleanupWarning,
  };
}

export async function prepareNewSeriesParts(ownerUserId, ownerChatId) {
  const draft = await getOwnerDraft(ownerUserId);

  if (
    !draft ||
    draft.ownerChatId !== ownerChatId ||
    draft.step !== 'part_choice' ||
    !draft.title ||
    !draft.status ||
    !Number.isSafeInteger(draft.seasonNumber) ||
    !draft.quality
  ) {
    throw new Error('The series details are incomplete.');
  }

  const normalizedTitle = normalizeTitle(draft.title);
  const existingSeries = await db
    .select()
    .from(series)
    .where(eq(series.normalizedTitle, normalizedTitle))
    .all();

  if (existingSeries.length > 0) {
    throw new Error(
      'A series with this title already exists. Use the edit workflow for existing series.',
    );
  }

  const blockingSession = await findBlockingUploadSession(ownerUserId);

  if (blockingSession) {
    throw new Error(
      'You already have an upload in progress or awaiting review. Finish or discard it first.',
    );
  }

  const [seriesRecord] = await db
    .insert(series)
    .values({
      title: draft.title,
      normalizedTitle,
      status: draft.status,
      published: false,
    })
    .returning()
    .run();

  try {
    await updateOwnerDraft(ownerUserId, {
      seriesId: seriesRecord.id,
      step: 'part_identifier',
    });
  } catch (error) {
    await db
      .delete(series)
      .where(eq(series.id, seriesRecord.id))
      .run();
    throw error;
  }

  return seriesRecord;
}

export async function prepareSeriesPartUpload(
  ownerUserId,
  ownerChatId,
  seasonNumber,
  partNumber,
) {
  const draft = await getOwnerDraft(ownerUserId);

  if (
    !draft ||
    draft.ownerChatId !== ownerChatId ||
    draft.step !== 'part_identifier' ||
    !Number.isSafeInteger(draft.seriesId) ||
    seasonNumber !== draft.seasonNumber ||
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1
  ) {
    throw new Error('Invalid season part details.');
  }

  const seriesRecord = await db
    .select()
    .from(series)
    .where(eq(series.id, draft.seriesId))
    .get();

  if (!seriesRecord) {
    throw new Error('The new series workflow could not be found.');
  }

  const existingSections = await db
    .select()
    .from(sections)
    .where(eq(sections.seriesId, seriesRecord.id))
    .all();

  if (
    existingSections.some(
      (item) =>
        item.seasonNumber === seasonNumber &&
        item.partNumber === partNumber,
    )
  ) {
    throw new Error(
      `Season ${seasonNumber}, Part ${partNumber} already exists for this series.`,
    );
  }

  let section;
  let session;

  try {
    [section] = await db
      .insert(sections)
      .values({
        seriesId: seriesRecord.id,
        seasonNumber,
        partNumber,
        quality: draft.quality,
        published: false,
      })
      .returning()
      .run();

    await updateOwnerDraft(ownerUserId, {
      step: 'part_upload',
      sectionId: section.id,
    });

    session = await createUploadSession({
      mode: 'add',
      ownerUserId,
      ownerChatId,
      seriesId: seriesRecord.id,
      sectionId: section.id,
    });
  } catch (error) {
    if (!session) {
      try {
        await updateOwnerDraft(ownerUserId, {
          step: 'part_identifier',
          sectionId: null,
        });
      } catch {
        // Preserve the setup error; a failed reset can be retried with /cancel.
      }

      if (section) {
        await db
          .delete(sections)
          .where(eq(sections.id, section.id))
          .run();
      }
    }
    throw error;
  }

  return { series: seriesRecord, section, session };
}


export async function prepareReplacementUpload(
  ownerUserId,
  ownerChatId,
  title,
  seasonNumber,
  quality,
  partNumber = 0,
) {
  if (
    !Number.isSafeInteger(ownerUserId) ||
    !Number.isSafeInteger(ownerChatId) ||
    typeof title !== 'string' ||
    !title.trim() ||
    !Number.isSafeInteger(seasonNumber) ||
    seasonNumber < 1 ||
    !Number.isSafeInteger(partNumber) ||
    partNumber < 0 ||
    typeof quality !== 'string' ||
    !quality.trim()
  ) {
    throw new Error('Invalid replacement details.');
  }

  const blockingSession = await findBlockingUploadSession(ownerUserId);

  if (blockingSession) {
    throw new Error(
      'Finish or discard your existing upload before starting a replacement.',
    );
  }

  const normalizedTitle = normalizeTitle(title);

  const matches = await db
    .select()
    .from(series)
    .where(eq(series.normalizedTitle, normalizedTitle))
    .all();

  const seriesRecord = matches.find((item) => item.published === true);

  if (!seriesRecord) {
    throw new Error('Published series not found.');
  }

  const matchingSections = await db
    .select()
    .from(sections)
    .where(eq(sections.seriesId, seriesRecord.id))
    .all();

  const section = matchingSections.find(
    (item) =>
      item.seasonNumber === seasonNumber &&
      (item.partNumber ?? 0) === partNumber &&
      item.quality.toLowerCase() === quality.trim().toLowerCase() &&
      item.published === true,
  );

  if (!section) {
    throw new Error(
      'Published season part and quality not found. Check the title, season, part, and quality.',
    );
  }

  const session = await createUploadSession({
    mode: 'replace',
    ownerUserId,
    ownerChatId,
    seriesId: seriesRecord.id,
    sectionId: section.id,
  });

  return { series: seriesRecord, section, session };
}


export async function prepareAddSeasonUpload(
  ownerUserId,
  ownerChatId,
  title,
  seasonNumber,
  quality,
) {
  if (
    !Number.isSafeInteger(ownerUserId) ||
    !Number.isSafeInteger(ownerChatId) ||
    typeof title !== 'string' ||
    !title.trim() ||
    !Number.isSafeInteger(seasonNumber) ||
    seasonNumber < 1 ||
    seasonNumber > 100 ||
    typeof quality !== 'string' ||
    !quality.trim()
  ) {
    throw new Error('Invalid season details.');
  }

  const blockingSession = await findBlockingUploadSession(ownerUserId);

  if (blockingSession) {
    throw new Error(
      'Finish or discard your existing upload before adding a season or quality.',
    );
  }

  const normalizedTitle = normalizeTitle(title);
  const matches = await db
    .select()
    .from(series)
    .where(eq(series.normalizedTitle, normalizedTitle))
    .all();

  const seriesRecord = matches.find((item) => item.published === true);

  if (!seriesRecord) {
    throw new Error('Published series not found.');
  }

  const existingSections = await db
    .select()
    .from(sections)
    .where(eq(sections.seriesId, seriesRecord.id))
    .all();

  const duplicate = existingSections.find(
    (item) =>
      item.seasonNumber === seasonNumber &&
      item.quality.trim().toLowerCase() === quality.trim().toLowerCase(),
  );

  if (duplicate) {
    throw new Error(
      `Season ${seasonNumber} already has the ${quality} quality. Choose a missing quality or use Edit Season to replace it.`,
    );
  }

  let section = null;
  let session = null;

  try {
    [section] = await db
      .insert(sections)
      .values({
        seriesId: seriesRecord.id,
        seasonNumber,
        quality: quality.trim(),
        published: false,
      })
      .returning()
      .run();

    session = await createUploadSession({
      mode: 'add',
      ownerUserId,
      ownerChatId,
      seriesId: seriesRecord.id,
      sectionId: section.id,
    });
  } catch (error) {
    if (section && !session) {
      try {
        await db
          .delete(sections)
          .where(eq(sections.id, section.id))
          .run();
      } catch {
        // Preserve the original error; manual cleanup may be required.
      }
    }

    throw error;
  }

  return { series: seriesRecord, section, session };
}

export async function prepareAppendEpisodeUpload(
  ownerUserId,
  ownerChatId,
  sectionId,
) {
  if (
    !Number.isSafeInteger(ownerUserId) ||
    !Number.isSafeInteger(ownerChatId) ||
    !Number.isSafeInteger(sectionId)
  ) {
    throw new Error('Invalid episode append details.');
  }

  const draft = await getOwnerDraft(ownerUserId);

  if (
    !draft ||
    draft.ownerChatId !== ownerChatId ||
    draft.step !== 'edit_add_episode_quality' ||
    !draft.title ||
    !Number.isSafeInteger(draft.seasonNumber)
  ) {
    throw new Error('Your episode-append selection expired. Start again from Edit Series.');
  }

  const blockingSession = await findBlockingUploadSession(ownerUserId);

  if (blockingSession) {
    throw new Error(
      'Finish or discard your existing upload before adding episodes.',
    );
  }

  const normalizedTitle = normalizeTitle(draft.title);
  const matches = await db
    .select()
    .from(series)
    .where(eq(series.normalizedTitle, normalizedTitle))
    .all();

  const seriesRecord = matches.find(
    (item) =>
      item.published === true &&
      (!Number.isSafeInteger(draft.seriesId) || item.id === draft.seriesId),
  );

  if (!seriesRecord) {
    throw new Error('Published series not found.');
  }

  const matchingSections = await db
    .select()
    .from(sections)
    .where(eq(sections.seriesId, seriesRecord.id))
    .all();

  const section = matchingSections.find(
    (item) =>
      item.id === sectionId &&
      item.seasonNumber === draft.seasonNumber &&
      item.published === true,
  );

  if (!section) {
    throw new Error(
      'That quality is not part of the selected published season. Start the selection again.',
    );
  }

  const session = await createUploadSession({
    mode: 'append',
    ownerUserId,
    ownerChatId,
    seriesId: seriesRecord.id,
    sectionId: section.id,
  });

  let draftCleanupWarning = false;
  try {
    await clearOwnerDraft(ownerUserId);
  } catch {
    draftCleanupWarning = true;
  }

  return { series: seriesRecord, section, session, draftCleanupWarning };
}