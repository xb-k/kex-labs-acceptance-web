/**
 * #168 P0 guard: cap mass physical media deletion per process.
 *
 * At 12:20:30Z a client deleted 152 media files in ~300ms via per-file
 * `DELETE /api/media/jobs/:job/:name`. A sliding window of 60s with at most
 * 20 accepted attempts turns a runaway loop into 429s instead of data loss.
 *
 * The budget counts attempts (successful or failed) after auth; rejected
 * requests do not extend the window. Injectable limit/window keep tests
 * deterministic and the process-wide instance resettable.
 */
export const MEDIA_DELETE_LIMIT = 20
export const MEDIA_DELETE_WINDOW_MS = 60_000

export type MediaDeleteGuard = {
  limit: number
  windowMs: number
  /** Timestamps (ms) of accepted attempts still inside the window. */
  hits: number[]
}

export function createMediaDeleteGuard(
  opts: { limit?: number; windowMs?: number } = {}
): MediaDeleteGuard {
  return {
    limit: opts.limit ?? MEDIA_DELETE_LIMIT,
    windowMs: opts.windowMs ?? MEDIA_DELETE_WINDOW_MS,
    hits: []
  }
}

/** Sliding window: expired timestamps leave one by one, not as a fixed bucket. */
export function consumeMediaDelete(guard: MediaDeleteGuard, now = Date.now()): boolean {
  const cutoff = now - guard.windowMs
  while (guard.hits.length > 0 && guard.hits[0] <= cutoff) guard.hits.shift()
  if (guard.hits.length >= guard.limit) return false
  guard.hits.push(now)
  return true
}

/** Drop the whole budget (tests only). */
export function resetMediaDeleteGuard(guard: MediaDeleteGuard): void {
  guard.hits.length = 0
}

/** Process-wide budget used by the real route. */
export const defaultMediaDeleteGuard = createMediaDeleteGuard()
