
export function buildSeasonKeyboard(result, requesterUserId) {
  const seasons = [...new Set(result.availableSeasons)]
    .sort((a, b) => a - b);

  return {
    inline_keyboard: seasons.map((seasonNumber) => [{
      text: `Season ${seasonNumber}`,
      callback_data: `season:${result.seriesId}:${seasonNumber}:${requesterUserId}`,
    }]),
  };
}

export function buildPartKeyboard(
  sections,
  seriesId,
  seasonNumber,
  requesterUserId,
) {
  const partNumbers = [...new Set(
    sections.map((section) => section.partNumber ?? 0),
  )].sort((a, b) => a - b);

  return {
    inline_keyboard: partNumbers.map((partNumber) => [{
      text: partNumber === 0 ? 'Full season' : `Part ${partNumber}`,
      callback_data:
        `part:${seriesId}:${seasonNumber}:${partNumber}:${requesterUserId}`,
    }]),
  };
}

export function buildQualityKeyboard(sections, requesterUserId) {
  const sortedSections = [...sections].sort((a, b) =>
    String(a.quality).localeCompare(String(b.quality), undefined, {
      numeric: true,
    }),
  );

  return {
    inline_keyboard: sortedSections.map((section) => [{
      text: section.quality,
      callback_data: `quality:${section.id ?? section.sectionId}:${requesterUserId}`,
    }]),
  };
}

export function buildDeliveryKeyboard(sectionId, seriesStatus, recipientUserId) {
  if (seriesStatus === 'finished') {
    return null;
  }

  if (seriesStatus !== 'ongoing') {
    throw new Error('Invalid series status.');
  }

  return {
    inline_keyboard: [
      [{
        text: 'All available episodes',
        callback_data: `deliver:${sectionId}:all:${recipientUserId}`,
      }],
      [{
        text: 'Latest episode only',
        callback_data: `deliver:${sectionId}:latest:${recipientUserId}`,
      }],
    ],
  };
}
