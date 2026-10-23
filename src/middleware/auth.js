'use strict';

const crypto = require('crypto');

// Compare via fixed-length hashes so the comparison time does not leak the secret's length or content.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** HTTP Basic authentication against a list of { user, pass }. */
function basicAuth({ users, disabled, realm }) {
  if (disabled) {
    return (req, res, next) => { req.user = 'anonymous'; next(); };
  }
  return (req, res, next) => {
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '');
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        const user = decoded.slice(0, i);
        const pass = decoded.slice(i + 1);
        // Check every entry (no early exit) to keep timing uniform.
        let ok = false;
        for (const u of users) ok = (safeEqual(u.user, user) && safeEqual(u.pass, pass)) || ok;
        if (ok) { req.user = user; return next(); }
      }
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).json({ error: 'Authentication required' });
  };
}

module.exports = { basicAuth };
