import { db } from 'sdk';
import { and, asc, eq, ne } from 'sdk/db';
import { episodes, sections } from '../schema.js';
import { getUploadSession } from './sessions.js';
import { parseEpisodeNumber } from './catalog.js';

function normalizeEpisodeNumber(value) {
  if (value == null || !/^\d+$/.test(String(value))) {
    return null;
  }

  return String(Number(value));
}

export async function recordCopiedEpisode({
  sessionId,
  ownerUserId,
  fileName,
  vaultChatId,
  vaultMessageId,
}) {
  const session = await getUploadSession(sessionId, ownerUserId);

  if (!session || session.status !== 'uploading') {
    throw new Error('No active upload session was found.');
  }

  const section = await db
    .select({ seasonNumber: sections.seasonNumber })
    .from(sections)
    .where(eq(sections.id, session.sectionId))
    .get();

  if (!section) {
    throw new Error('The target season and quality section was not found.');
  }

  if (
    typeof fileName !== 'string' ||
    !fileName.trim() ||
    !Number.isSafeInteger(vaultMessageId) ||
    typeof vaultChatId !== 'string' ||
    !vaultChatId
  ) {
    throw new Error('Invalid episode metadata.');
  }

  const existingCount = await db.$count(
    episodes,
    eq(episodes.sessionId, sessionId),
  );

  const parsed = parseEpisodeNumber(fileName);

  const [episode] = await db
    .insert(episodes)
    .values({
      sectionId: session.sectionId,
      sessionId,
      fileName: fileName.trim(),
      episodeNumber: parsed?.episodeNumber ?? null,
      vaultChatId,
      vaultMessageId,
      uploadOrder: existingCount + 1,
      published: false,
    })
    .returning()
    .run();

  return {
    episode,
    parsed,
    uploadOrder: episode.uploadOrder,
    seasonMismatch:
      parsed !== null && parsed.seasonNumber !== section.seasonNumber,
  };
}

export async function analyzeUploadSession(sessionId, ownerUserId) {
  const session = await getUploadSession(sessionId, ownerUserId);

  if (!session) {
    throw new Error('Upload session not found.');
  }

  const rows = await db
    .select({
      fileName: episodes.fileName,
      episodeNumber: episodes.episodeNumber,
      uploadOrder: episodes.uploadOrder,
    })
    .from(episodes)
    .where(eq(episodes.sessionId, sessionId))
    .orderBy(asc(episodes.uploadOrder), asc(episodes.id))
    .all();

  const section = await db
    .select({ seasonNumber: sections.seasonNumber })
    .from(sections)
    .where(eq(sections.id, session.sectionId))
    .get();

  if (!section) {
    throw new Error('The target season and quality section was not found.');
  }

  // Only append sessions need collision checks against existing episodes.
  const publishedEpisodes =
    session.mode === 'append'
      ? await db
          .select({
            episodeNumber: episodes.episodeNumber,
            fileName: episodes.fileName,
          })
          .from(episodes)
          .where(
            and(
              eq(episodes.sectionId, session.sectionId),
              eq(episodes.published, true),
              ne(episodes.sessionId, sessionId),
            ),
          )
          .all()
      : [];

  const publishedEpisodeNumbers = new Set();

  for (const episode of publishedEpisodes) {
    const number =
      episode.episodeNumber ??
      parseEpisodeNumber(episode.fileName)?.episodeNumber;

    const normalized = normalizeEpisodeNumber(number);

    if (normalized !== null) {
      publishedEpisodeNumbers.add(normalized);
    }
  }

  const seenNames = new Set();
  const seenEpisodeNumbers = new Set();

  const reviewed = rows.map((episode) => {
    const reviewFlags = [];
    const normalizedName = episode.fileName
      .normalize('NFKC')
      .toLowerCase()
      .trim();

    const parsed = parseEpisodeNumber(episode.fileName);

    if (!parsed) {
      reviewFlags.push('unrecognized_episode_number');
    } else {
      if (
        parsed.seasonNumber != null &&
        parsed.seasonNumber !== section.seasonNumber
      ) {
        reviewFlags.push('season_mismatch');
      }

      const normalizedNumber = normalizeEpisodeNumber(
        parsed.episodeNumber,
      );

      if (
        normalizedNumber !== null &&
        seenEpisodeNumbers.has(normalizedNumber)
      ) {
        reviewFlags.push('duplicate_episode_number');
      }

      if (
        normalizedNumber !== null &&
        publishedEpisodeNumbers.has(normalizedNumber)
      ) {
        reviewFlags.push('duplicate_episode_number_existing');
      }

      if (normalizedNumber !== null) {
        seenEpisodeNumbers.add(normalizedNumber);
      }
    }

    if (seenNames.has(normalizedName)) {
      reviewFlags.push('duplicate_filename');
    }

    seenNames.add(normalizedName);

    return {
      ...episode,
      reviewFlags,
    };
  });

  return {
    sessionId,
    totalEpisodes: reviewed.length,
    episodes: reviewed,
    needsReview: reviewed.some(
      (episode) => episode.reviewFlags.length > 0,
    ),
  };
}