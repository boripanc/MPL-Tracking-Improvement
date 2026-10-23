'use strict';

const path = require('path');
const express = require('express');
const { apiRouter } = require('./routes/api');
const { basicAuth } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errors');
const { cpiConfigured } = require('./config');
const { createClient } = require('./cpi/client');
const { createCertificateService } = require('./cpi/certificates');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// chart.js does not export its dist folder, so resolve it from the package's main file.
const CHART_JS = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
}

/** Creates the Express application. `pool` is a pg Pool, `config` comes from loadConfig(). */
function createApp({ pool, config, certificates }) {
  const app = express();
  if (certificates === undefined && cpiConfigured(config)) {
    certificates = createCertificateService({
      client: createClient(config.poller),
      thresholds: { criticalDays: config.certificates.criticalDays, warnDays: config.certificates.warnDays },
      cacheMinutes: config.certificates.cacheMinutes,
    });
  }
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);

  // Health check stays public so load balancers / Docker can probe it.
  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  app.use(basicAuth(config.auth));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', apiRouter({ pool, config, certificates: certificates || null }));
  app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(CHART_JS, { maxAge: '7d' }));
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
