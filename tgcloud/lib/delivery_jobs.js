
import { db } from 'sdk';
import { and, desc, eq } from 'sdk/db';
import { deliveryJobs } from '../schema.js';

const VALID_MODES = ['all', 'latest'];
const VALID_STATUSES = ['pending', 'running', 'completed', 'failed'];

export async function createDeliveryJob({
  ownerUserId,
  targetUserId,
  sectionId,
  mode,
}) {
  if (
    !Number.isSafeInteger(ownerUserId) ||
    !Number.isSafeInteger(targetUserId) ||
    !Number.isSafeInteger(sectionId) ||
    ownerUserId < 1 ||
    targetUserId < 1 ||
    sectionId < 1
  ) {
    throw new Error('Invalid delivery-job identifiers.');
  }

  if (!VALID_MODES.includes(mode)) {
    throw new Error('Invalid delivery mode.');
  }

  const [job] = await db
    .insert(deliveryJobs)
    .values({
      ownerUserId,
      targetUserId,
      sectionId,
      mode,
      status: 'pending',
      lastEpisodeId: null,
      retryAfterAt: null,
      lockToken: null,
      lockExpiresAt: null,
    })
    .returning()
    .run();

  return job;
}

export async function getDeliveryJob(jobId, targetUserId) {
  if (
    !Number.isSafeInteger(jobId) ||
    !Number.isSafeInteger(targetUserId)
  ) {
    return null;
  }

  return await db
    .select()
    .from(deliveryJobs)
    .where(
      and(
        eq(deliveryJobs.id, jobId),
        eq(deliveryJobs.targetUserId, targetUserId),
      ),
    )
    .get();
}

export async function findLatestActiveDeliveryJob(targetUserId) {
  const jobs = await db
    .select()
    .from(deliveryJobs)
    .where(eq(deliveryJobs.targetUserId, targetUserId))
    .orderBy(desc(deliveryJobs.id))
    .all();

  return jobs.find(
    (job) =>
      job.status === 'pending' ||
      job.status === 'running',
  ) ?? null;
}


export async function findMatchingActiveDeliveryJob({
  targetUserId,
  sectionId,
  mode,
}) {
  if (
    !Number.isSafeInteger(targetUserId) ||
    !Number.isSafeInteger(sectionId) ||
    targetUserId < 1 ||
    sectionId < 1 ||
    !VALID_MODES.includes(mode)
  ) {
    throw new Error('Invalid active delivery-job lookup.');
  }

  const jobs = await db
    .select()
    .from(deliveryJobs)
    .where(
      and(
        eq(deliveryJobs.targetUserId, targetUserId),
        eq(deliveryJobs.sectionId, sectionId),
        eq(deliveryJobs.mode, mode),
      ),
    )
    .orderBy(desc(deliveryJobs.id))
    .all();

  return jobs.find(
    (job) =>
      job.status === 'pending' ||
      job.status === 'running',
  ) ?? null;
}


export async function updateDeliveryJob(jobId, targetUserId, changes) {
  const job = await getDeliveryJob(jobId, targetUserId);

  if (!job) {
    throw new Error('Delivery job not found.');
  }

  if (!['pending', 'running'].includes(job.status)) {
    throw new Error('This delivery job is no longer active.');
  }

    const allowedFields = [
    'status',
    'lastEpisodeId',
    'retryAfterAt',
    'lockToken',
    'lockExpiresAt',
  ];
  const update = {};

  for (const field of allowedFields) {
    if (Object.hasOwn(changes, field)) {
      update[field] = changes[field];
    }
  }

  if (
    update.status !== undefined &&
    !VALID_STATUSES.includes(update.status)
  ) {
    throw new Error('Invalid delivery-job status.');
  }

  if (
    update.lastEpisodeId !== undefined &&
    update.lastEpisodeId !== null &&
    (!Number.isSafeInteger(update.lastEpisodeId) ||
      update.lastEpisodeId < 1)
  ) {
    throw new Error('Invalid last episode ID.');
  }

  if (
    update.retryAfterAt !== undefined &&
    update.retryAfterAt !== null &&
    (!Number.isSafeInteger(update.retryAfterAt) ||
      update.retryAfterAt < 0)
  ) {
    throw new Error('Invalid retry deadline.');
  }

  if (Object.keys(update).length === 0) {
    return job;
  }

  update.updatedAt = Math.floor(Date.now() / 1000);

  await db
    .update(deliveryJobs)
    .set(update)
    .where(
      and(
        eq(deliveryJobs.id, jobId),
        eq(deliveryJobs.targetUserId, targetUserId),
      ),
    )
    .run();

  return await getDeliveryJob(jobId, targetUserId);
}


const DELIVERY_LOCK_SECONDS = 120;

export async function claimDeliveryJob(jobId, targetUserId, lockToken) {
  if (
    !Number.isSafeInteger(jobId) ||
    !Number.isSafeInteger(targetUserId) ||
    typeof lockToken !== 'string' ||
    lockToken.length < 16
  ) {
    throw new Error('Invalid delivery-lock parameters.');
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + DELIVERY_LOCK_SECONDS;

  const result = await db.run(
    `UPDATE delivery_jobs
     SET lock_token = :lockToken,
         lock_expires_at = :expiresAt,
         updated_at = :now
     WHERE id = :jobId
       AND target_user_id = :targetUserId
       AND status IN ('pending', 'running')
       AND (lock_expires_at IS NULL OR lock_expires_at <= :now)`,
    {
      ':lockToken': lockToken,
      ':expiresAt': expiresAt,
      ':now': now,
      ':jobId': jobId,
      ':targetUserId': targetUserId,
    },
  );

  return result.rowsAffected === 1;
}

export async function releaseDeliveryJobLock(
  jobId,
  targetUserId,
  lockToken,
) {
  const now = Math.floor(Date.now() / 1000);

  const result = await db.run(
    `UPDATE delivery_jobs
     SET lock_token = NULL,
         lock_expires_at = NULL,
         updated_at = :now
     WHERE id = :jobId
       AND target_user_id = :targetUserId
       AND lock_token = :lockToken`,
    {
      ':now': now,
      ':jobId': jobId,
      ':targetUserId': targetUserId,
      ':lockToken': lockToken,
    },
  );

  return result.rowsAffected === 1;
}


export async function updateClaimedDeliveryJob(
  jobId,
  targetUserId,
  lockToken,
  changes,
) {
  if (
    !Number.isSafeInteger(jobId) ||
    !Number.isSafeInteger(targetUserId) ||
    typeof lockToken !== 'string' ||
    lockToken.length < 16
  ) {
    throw new Error('Invalid claimed-job update parameters.');
  }

  const allowedFields = [
    'status',
    'lastEpisodeId',
    'retryAfterAt',
  ];

  const update = {};

  for (const field of allowedFields) {
    if (Object.hasOwn(changes, field)) {
      update[field] = changes[field];
    }
  }

  if (Object.keys(update).length === 0) {
    throw new Error('No valid delivery-job changes were supplied.');
  }

  if (
    update.status !== undefined &&
    !VALID_STATUSES.includes(update.status)
  ) {
    throw new Error('Invalid delivery-job status.');
  }

  if (
    update.lastEpisodeId !== undefined &&
    update.lastEpisodeId !== null &&
    (!Number.isSafeInteger(update.lastEpisodeId) ||
      update.lastEpisodeId < 1)
  ) {
    throw new Error('Invalid last episode ID.');
  }

  if (
    update.retryAfterAt !== undefined &&
    update.retryAfterAt !== null &&
    (!Number.isSafeInteger(update.retryAfterAt) ||
      update.retryAfterAt < 0)
  ) {
    throw new Error('Invalid retry deadline.');
  }

  const columnNames = {
    status: 'status',
    lastEpisodeId: 'last_episode_id',
    retryAfterAt: 'retry_after_at',
  };

  const assignments = [];
  const params = {
    ':jobId': jobId,
    ':targetUserId': targetUserId,
    ':lockToken': lockToken,
    ':now': Math.floor(Date.now() / 1000),
  };

  for (const [field, value] of Object.entries(update)) {
    const parameter = `:${field}`;
    assignments.push(`${columnNames[field]} = ${parameter}`);
    params[parameter] = value;
  }

  assignments.push('updated_at = :now');

  const result = await db.run(
    `UPDATE delivery_jobs
     SET ${assignments.join(', ')}
     WHERE id = :jobId
       AND target_user_id = :targetUserId
       AND lock_token = :lockToken
       AND lock_expires_at > :now
       AND status IN ('pending', 'running')`,
    params,
  );

  if (result.rowsAffected !== 1) {
    throw new Error(
      'Delivery lock expired or was lost; progress update rejected.',
    );
  }

  return await getDeliveryJob(jobId, targetUserId);
}


export async function renewDeliveryJobLock(
  jobId,
  targetUserId,
  lockToken,
) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + DELIVERY_LOCK_SECONDS;

  const result = await db.run(
    `UPDATE delivery_jobs
     SET lock_expires_at = :expiresAt,
         updated_at = :now
     WHERE id = :jobId
       AND target_user_id = :targetUserId
       AND lock_token = :lockToken
       AND lock_expires_at > :now
       AND status IN ('pending', 'running')`,
    {
      ':expiresAt': expiresAt,
      ':now': now,
      ':jobId': jobId,
      ':targetUserId': targetUserId,
      ':lockToken': lockToken,
    },
  );

  return result.rowsAffected === 1;
}
