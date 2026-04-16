/**
 * rate-limit-helper.mjs -- Shared rate-limit retry logic
 *
 * Wraps Anthropic API calls with automatic retry on 429 (rate limit)
 * errors. Reads the retry-after header and waits accordingly.
 *
 * Usage:
 *   import { withRetry } from './rate-limit-helper.mjs';
 *   const response = await withRetry(() => client.messages.create({...}));
 */

const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER = 120; // seconds, if no retry-after header

/**
 * Wraps an async function with retry logic for rate-limit (429) errors.
 * On 429, waits for the retry-after period (from headers or default)
 * then retries up to MAX_RETRIES times.
 */
async function withRetry(fn, label = 'api-call') {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit =
        err?.status === 429 ||
        err?.error?.error?.type === 'rate_limit_error' ||
        err?.message?.includes('rate_limit');

      if (!isRateLimit || attempt === MAX_RETRIES) {
        throw err;
      }

      // Extract retry-after from error headers or use default
      let retryAfter = DEFAULT_RETRY_AFTER;
      if (err?.headers?.['retry-after']) {
        retryAfter = parseInt(err.headers['retry-after'], 10) || DEFAULT_RETRY_AFTER;
      } else if (err?.response?.headers?.['retry-after']) {
        retryAfter = parseInt(err.response.headers['retry-after'], 10) || DEFAULT_RETRY_AFTER;
      }

      // Add a small buffer to be safe
      retryAfter = Math.min(retryAfter + 10, 600);

      console.log(`[${label}] Rate limited (429). Attempt ${attempt}/${MAX_RETRIES}. Waiting ${retryAfter}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      console.log(`[${label}] Retrying after rate-limit wait...`);
    }
  }
}

export { withRetry };
