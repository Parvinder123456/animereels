import { logger } from './logger.js';

export async function retry(fn, { maxAttempts = 3, baseDelayMs = 2000, label = 'op' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`${label} attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  logger.error(`${label} failed after ${maxAttempts} attempts`);
  throw lastError;
}
