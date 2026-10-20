
export function normalizeTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseEpisodeNumber(fileName) {
  const name = String(fileName ?? '');

  // S02E05, S2 E5, s02.e05
  const standard = name.match(
    /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})(?:[^0-9]|$)/i,
  );

  if (standard) {
    return {
      seasonNumber: Number(standard[1]),
      episodeNumber: standard[2].padStart(2, '0'),
      format: 'season-episode',
    };
  }

  // 2x05, 02 x 105
  const cross = name.match(
    /(?:^|[^0-9])(\d{1,2})\s*x\s*(\d{1,3})(?:[^0-9]|$)/i,
  );

  if (cross) {
    return {
      seasonNumber: Number(cross[1]),
      episodeNumber: cross[2].padStart(2, '0'),
      format: 'season-x-episode',
    };
  }

  // Season 2 Episode 5
  const words = name.match(
    /season[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})(?:[^0-9]|$)/i,
  );

  if (words) {
    return {
      seasonNumber: Number(words[1]),
      episodeNumber: words[2].padStart(2, '0'),
      format: 'season-episode-words',
    };
  }

  // EP01, EP 01, Episode 1, Episode_001
  const episodeOnly = name.match(
    /(?:^|[^a-z0-9])(?:ep|episode)[\s._-]*(\d{1,3})(?:[^0-9]|$)/i,
  );

  if (episodeOnly) {
    return {
      seasonNumber: null,
      episodeNumber: episodeOnly[1].padStart(2, '0'),
      format: 'episode-only',
    };
  }

  return null;
}
