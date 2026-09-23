import type { Send } from './core/http.js';
import type { Activity, ActivityQuery } from './types/activity.js';
import type { RequestOptions } from './types/common.js';

/** The caller's swaps, deposits and withdrawals in one history, newest first. */
export async function listActivity(
  send: Send,
  query: ActivityQuery = {},
  options?: RequestOptions,
): Promise<Activity> {
  return send<Activity>(
    {
      method: 'GET',
      path: '/v1/activity',
      query: { type: 'all', status: query.status, limit: query.limit, cursor: query.cursor },
    },
    options,
  );
}
