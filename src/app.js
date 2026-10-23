'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { apiRouter } = require('./routes/api');
const { basicAuth } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errors');
const { cpiConfigured } = require('./config');
const { createClient } = require('./cpi/client');
const { createCertificateStore } = require('./cpi/certificates');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

// Adds ?v=<version>-<file mtime> to the script and stylesheet links, so a new release is never mixed with
// files the browser cached from an older one.
let cachedIndex = null;
function indexHtml() {
  const stamp = (file) => `${VERSION}-${Math.floor(fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs)}`;
  const key = stamp('index.html') + stamp('app.js') + stamp('styles.css');
  if (!cachedIndex || cachedIndex.key !== key) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace('href="styles.css"', `href="styles.css?v=${stamp('styles.css')}"`)
      .replace('src="app.js"', `src="app.js?v=${stamp('app.js')}"`)
      .replace('src="vendor/chart.umd.js"', `src="vendor/chart.umd.js?v=${VERSION}"`);
    cachedIndex = { key, html };
  }
  return cachedIndex.html;
}
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
  if (!certificates) {
    certificates = createCertificateStore({
      pool,
      client: cpiConfigured(config) ? createClient(config.poller) : null,
      thresholds: { criticalDays: config.certificates.criticalDays, warnDays: config.certificates.warnDays },
      staleHours: config.certificates.staleHours,
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
  app.use('/api', apiRouter({ pool, config, certificates }));
  app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(CHART_JS, { maxAge: '7d' }));
  // index.html, app.js and styles.css must always match each other, so the browser re-validates them on every
  // load (a cheap 304 when unchanged) instead of keeping an old copy after an upgrade.
  app.get(['/', '/index.html'], (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(indexHtml()));
  app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.use(errorHandler);
  app.locals.certificates = certificates;
  return app;
}

module.exports = { createApp };
