
import { api, BotApiError, db } from 'sdk';
import { asc, and, eq } from 'sdk/db';
import { episodes, sections, series } from '../schema.js';
import {
  getDeliveryJob,
  claimDeliveryJob,
  renewDeliveryJobLock,
  releaseDeliveryJobLock,
  updateClaimedDeliveryJob,
} from './delivery_jobs.js';
import { parseEpisodeNumber } from './catalog.js';

const BATCH_SIZE = 5;

function getNumericEpisodeNumber(episode) {
  const value =
    episode.episodeNumber ??
    parseEpisodeNumber(episode.fileName)?.episodeNumber;

  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeLockToken(jobId, targetUserId) {
  return [
    jobId,
    targetUserId,
    Date.now(),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join('-');
}

export async function processDeliveryJob({ jobId, targetUserId }) {
  const initialJob = await getDeliveryJob(jobId, targetUserId);

  if (!initialJob) {
    throw new Error('Delivery job not found.');
  }

  if (initialJob.status === 'completed') {
    return {
      status: 'completed',
      sentThisBatch: 0,
      message: 'This delivery is already complete.',
    };
  }

  if (!['pending', 'running'].includes(initialJob.status)) {
    throw new Error('This delivery job is not active.');
  }

  const lockToken = makeLockToken(jobId, targetUserId);
  const claimed = await claimDeliveryJob(
    jobId,
    targetUserId,
    lockToken,
  );

  if (!claimed) {
    return {
      status: 'busy',
      sentThisBatch: 0,
      message: 'Another invocation is already processing this delivery.',
    };
  }

  try {
    let job = await getDeliveryJob(jobId, targetUserId);

    if (!job || job.lockToken !== lockToken) {
      throw new Error('Delivery lock was lost.');
    }

    if (
      job.retryAfterAt !== null &&
      job.retryAfterAt !== undefined
    ) {
      const secondsRemaining =
        job.retryAfterAt - Math.floor(Date.now() / 1000);

      if (secondsRemaining > 0) {
        return {
          status: 'waiting',
          sentThisBatch: 0,
          retryAfter: secondsRemaining,
          message: 'Telegram rate limit cooldown has not expired.',
        };
      }

      await updateClaimedDeliveryJob(
        jobId,
        targetUserId,
        lockToken,
        { retryAfterAt: null },
      );
    }

    const section = await db
      .select()
      .from(sections)
      .where(
        and(
          eq(sections.id, job.sectionId),
          eq(sections.published, true),
        ),
      )
      .get();

    if (!section) {
      await updateClaimedDeliveryJob(
        jobId,
        targetUserId,
        lockToken,
        { status: 'failed' },
      );
      throw new Error(
        'This season and quality section is no longer available.',
      );
    }

    const seriesRecord = await db
      .select()
      .from(series)
      .where(
        and(
          eq(series.id, section.seriesId),
          eq(series.published, true),
        ),
      )
      .get();

    if (!seriesRecord) {
      await updateClaimedDeliveryJob(
        jobId,
        targetUserId,
        lockToken,
        { status: 'failed' },
      );
      throw new Error('This series is no longer available.');
    }

    const allEpisodes = await db
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.sectionId, job.sectionId),
          eq(episodes.published, true),
        ),
      )
      .orderBy(asc(episodes.uploadOrder))
      .all();

    allEpisodes.sort((a, b) => {
      const aNumber = getNumericEpisodeNumber(a);
      const bNumber = getNumericEpisodeNumber(b);

      if (aNumber !== null && bNumber !== null && aNumber !== bNumber) {
        return aNumber - bNumber;
      }

      if (aNumber !== null && bNumber === null) {
        return -1;
      }

      if (aNumber === null && bNumber !== null) {
        return 1;
      }

      return (
        (a.uploadOrder ?? 0) - (b.uploadOrder ?? 0) ||
        a.id - b.id
      );
    });

    if (allEpisodes.length === 0) {
      await updateClaimedDeliveryJob(
        jobId,
        targetUserId,
        lockToken,
        { status: 'failed' },
      );
      throw new Error('No published episodes are available.');
    }

    const selectedEpisodes =
      job.mode === 'latest'
        ? [allEpisodes[allEpisodes.length - 1]]
        : allEpisodes;

    let startIndex = 0;

    if (
      job.lastEpisodeId !== null &&
      job.lastEpisodeId !== undefined
    ) {
      const cursorIndex = selectedEpisodes.findIndex(
        (episode) => episode.id === job.lastEpisodeId,
      );

      if (cursorIndex === -1) {
        await updateClaimedDeliveryJob(
          jobId,
          targetUserId,
          lockToken,
          { status: 'failed' },
        );

        throw new Error(
          'Saved delivery progress no longer matches the published episodes. Start a new delivery.',
        );
      }

      startIndex = cursorIndex + 1;
    }

    if (startIndex >= selectedEpisodes.length) {
      await updateClaimedDeliveryJob(
        jobId,
        targetUserId,
        lockToken,
        { status: 'completed', retryAfterAt: null },
      );

      return {
        status: 'completed',
        sentThisBatch: 0,
        message: 'All selected episodes have been delivered.',
      };
    }

    const batch = selectedEpisodes.slice(
      startIndex,
      startIndex + BATCH_SIZE,
    );

    let sentThisBatch = 0;
    let lastDeliveredEpisodeId = job.lastEpisodeId ?? null;

    for (const episode of batch) {
      // Renew before each Telegram side effect.
      const renewed = await renewDeliveryJobLock(
        jobId,
        targetUserId,
        lockToken,
      );

      if (!renewed) {
        throw new Error(
          'Delivery lock expired or was lost before sending the next episode.',
        );
      }

      try {
        await api.copyMessage({
          chat_id: targetUserId,
          from_chat_id: episode.vaultChatId,
          message_id: episode.vaultMessageId,
        });
      } catch (error) {
        const retryAfter =
          error instanceof BotApiError
            ? Number(error.parameters?.retry_after)
            : 0;

        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          const retryAfterAt =
            Math.floor(Date.now() / 1000) + Math.ceil(retryAfter);

          await updateClaimedDeliveryJob(
            jobId,
            targetUserId,
            lockToken,
            {
              status: 'running',
              lastEpisodeId: lastDeliveredEpisodeId,
              retryAfterAt,
            },
          );

          return {
            status: 'waiting',
            sentThisBatch,
            retryAfter: Math.ceil(retryAfter),
            message:
              'Telegram rate-limited this delivery. Resume after the indicated wait.',
          };
        }

        await updateClaimedDeliveryJob(
          jobId,
          targetUserId,
          lockToken,
          {
            status: 'failed',
            lastEpisodeId: lastDeliveredEpisodeId,
            retryAfterAt: null,
          },
        );

        throw error;
      }

      lastDeliveredEpisodeId = episode.id;
      sentThisBatch += 1;

      await updateClaimedDeliveryJob(
        jobId,
        targetUserId,
        lockToken,
        {
          status: 'running',
          lastEpisodeId: lastDeliveredEpisodeId,
          retryAfterAt: null,
        },
      );
    }

    const finished =
      startIndex + sentThisBatch >= selectedEpisodes.length;

    await updateClaimedDeliveryJob(
      jobId,
      targetUserId,
      lockToken,
      {
        status: finished ? 'completed' : 'running',
        lastEpisodeId: lastDeliveredEpisodeId,
        retryAfterAt: null,
      },
    );

    return {
      status: finished ? 'completed' : 'running',
      sentThisBatch,
      remaining: Math.max(
        0,
        selectedEpisodes.length - startIndex - sentThisBatch,
      ),
      message: finished
        ? 'All selected episodes have been delivered.'
        : 'Batch delivered. Continue to receive the remaining episodes.',
    };
  } finally {
    // Release only if this invocation still owns the token.
    await releaseDeliveryJobLock(
      jobId,
      targetUserId,
      lockToken,
    );
  }
}
