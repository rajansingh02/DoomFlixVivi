
import { db } from 'sdk';
import { asc, eq } from 'sdk/db';
import { sections, series } from '../schema.js';
import { normalizeTitle } from './catalog.js';

function extractSeasonRequest(query) {
  let seasonNumber = null;
  let titleQuery = query;

  const patterns = [
    /\bseason[\s._-]*(\d{1,2})\b/i,
    /(?:^|\s)s(\d{1,2})(?=\s|$)/i,
  ];

  for (const pattern of patterns) {
    const match = titleQuery.match(pattern);

    if (match) {
      seasonNumber = Number(match[1]);
      titleQuery = titleQuery.replace(match[0], ' ');
      break;
    }
  }

  // Also recognize episode-style hints such as S02E05.
  const episodeHint = titleQuery.match(
    /(?:^|\s)s(\d{1,2})[\s._-]*e\d{1,3}\b/i,
  );

  if (episodeHint) {
    seasonNumber = Number(episodeHint[1]);
    titleQuery = titleQuery.replace(episodeHint[0], ' ');
  }

  return {
    seasonNumber,
    titleQuery: normalizeTitle(titleQuery),
  };
}

function similarityScore(query, title) {
  if (!query || !title) return 0;
  if (query === title) return 1;

  if (title.includes(query) && query.length >= 4) {
    return 0.9;
  }

  if (query.includes(title) && title.length >= 4) {
    return 0.88;
  }

  const queryTokens = new Set(query.split(' '));
  const titleTokens = new Set(title.split(' '));

  let overlap = 0;

  for (const token of queryTokens) {
    if (titleTokens.has(token)) overlap++;
  }

  const queryCoverage = overlap / queryTokens.size;
  const titleCoverage = overlap / titleTokens.size;

  if (queryCoverage === 1 && titleCoverage >= 0.5) {
    return 0.82;
  }

  if (queryCoverage >= 0.75 && titleCoverage >= 0.75) {
    return 0.76;
  }

  return 0;
}

export async function searchPublishedSeries(rawQuery) {
  const { seasonNumber, titleQuery } = extractSeasonRequest(
    String(rawQuery ?? '').trim(),
  );

  if (!titleQuery) {
    return [];
  }

  const publishedSeries = await db
    .select()
    .from(series)
    .where(eq(series.published, true))
    .all();

  const scored = publishedSeries
    .map((item) => ({
      item,
      score: similarityScore(titleQuery, item.normalizedTitle),
    }))
    .filter((entry) => entry.score >= 0.76)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return [];
  }

  // Avoid choosing an arbitrary series when the best matches are tied.
  const bestScore = scored[0].score;
  const bestMatches = scored.filter(
    (entry) => entry.score === bestScore,
  );

  const candidates = bestMatches.length === 1
    ? bestMatches
    : bestMatches.filter((entry) => entry.score === 1);

  if (candidates.length !== 1) {
    return [];
  }

  const matchedSeries = candidates[0].item;

  const availableSections = await db
    .select()
    .from(sections)
    .where(eq(sections.seriesId, matchedSeries.id))
    .all();

  const publishedSections = availableSections
    .filter((section) => section.published)
    .sort((a, b) => a.seasonNumber - b.seasonNumber);

  const availableSeasons = [
    ...new Set(publishedSections.map((section) => section.seasonNumber)),
  ];

  if (
    seasonNumber !== null &&
    !availableSeasons.includes(seasonNumber)
  ) {
    return [];
  }

  const selectedSections = seasonNumber === null
    ? publishedSections
    : publishedSections.filter(
        (section) => section.seasonNumber === seasonNumber,
      );

  if (selectedSections.length === 0) {
    return [];
  }

  return [{
    seriesId: matchedSeries.id,
    title: matchedSeries.title,
    status: matchedSeries.status,
    requestedSeason: seasonNumber,
    availableSeasons,
    sections: selectedSections.map((section) => ({
      sectionId: section.id,
      seasonNumber: section.seasonNumber,
      partNumber: section.partNumber ?? 0,
      quality: section.quality,
    })),
  }];
}
