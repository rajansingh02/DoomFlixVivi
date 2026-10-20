
import { normalizeTitle, parseEpisodeNumber } from './catalog-test.mjs';

const titleTests = [
  ['The Vampire Diaries', 'the vampire diaries'],
  ['THE.VAMPIRE.DIARIES', 'the vampire diaries'],
  ['  The   Vampire   Diaries  ', 'the vampire diaries'],
];

for (const [input, expected] of titleTests) {
  const actual = normalizeTitle(input);
  console.log(
    actual === expected ? 'PASS' : 'FAIL',
    'title:',
    JSON.stringify(input),
    '=>',
    JSON.stringify(actual),
  );
}

const episodeTests = [
  ['The.Vampire.Diaries.S02E05.1080p.mkv', 2, '05'],
  ['Show.2x105.WEB-DL.mkv', 2, '105'],
  ['Show.Season.3.Episode.7.mkv', 3, '07'],
  ['Show.Special.mkv', null, null],
];

for (const [fileName, expectedSeason, expectedEpisode] of episodeTests) {
  const actual = parseEpisodeNumber(fileName);
  const passed = expectedSeason === null
    ? actual === null
    : actual?.seasonNumber === expectedSeason &&
      actual?.episodeNumber === expectedEpisode;

  console.log(
    passed ? 'PASS' : 'FAIL',
    'episode:',
    fileName,
    '=>',
    actual,
  );
}
