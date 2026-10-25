'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Map PostgreSQL error codes that come from user input to 4xx responses.
const PG_CLIENT_ERRORS = {
  '2201B': [400, (e) => `Invalid regular expression: ${e.message.replace(/^invalid regular expression:\s*/i, '')}`],
  '22P02': [400, () => 'Invalid value in request'],
  '22007': [400, () => 'Invalid date/time value'],
  '22008': [400, () => 'Invalid date/time value'],
  '22023': [400, (e) => e.message],
  '23514': [400, () => 'Value not allowed (check constraint)'],
  '23503': [404, () => 'Referenced record not found'],
};

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.connect ? { connect: true } : {}) });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  const mapped = err && err.code && PG_CLIENT_ERRORS[err.code];
  if (mapped) return res.status(mapped[0]).json({ error: mapped[1](err) });
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { HttpError, errorHandler };
