/**
 * A column of figures.
 *
 * The venue reads money down the right edge and lines the digits up, so a
 * reader can compare two rows without counting places. The kit has no numeric
 * preset, so this is where that decision lives. It is a value to spread rather
 * than a wrapper, so each column keeps the kit's own contextual typing.
 */
export const NUMERIC = {
  align: 'end',
  headerClassName: 'tabular-nums',
  cellClassName: 'tabular-nums',
} as const;
