import { logger } from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  logger.error(`${req.method} ${req.path} - ${err.message}`);
  if (err.stack) logger.debug(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
}
