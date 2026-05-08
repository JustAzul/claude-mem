export const UI = {
  PAGINATION_PAGE_SIZE: 50,

  /** Default time window for paginated queries (0 = all-time) */
  DEFAULT_WITHIN_DAYS: 30,

  /** Intersection observer threshold (0-1, percentage of visibility needed to trigger) */
  LOAD_MORE_THRESHOLD: 0.1,
} as const;
