export const parseAudiences = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((audience) => audience.trim())
    .filter((audience) => audience !== '');
