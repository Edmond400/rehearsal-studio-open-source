// Bound each request's hashing and binary-to-hex conversion independently of file size.
export const MEDIA_PART_BYTES = 256 * 1024;
export const MEDIA_RANGE_BYTES = 256 * 1024;
export const R2_PART_BYTES = 5 * 1024 * 1024;
export const MAX_R2_DECK_BYTES = 50 * 1024 * 1024;
export const R2_SITE_MEDIA_BUDGET = 8_000_000_000;
export const R2_PROJECT_MEDIA_BUDGET = 300 * 1024 * 1024;
