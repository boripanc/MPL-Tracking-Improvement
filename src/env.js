'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Loads .env from the current folder and from the project folder (next to package.json), so the app finds its
 * settings no matter where it is started from (PM2, systemd, another folder). Real environment variables always
 * win over values in a file. Returns the files that were read.
 */
function loadEnvFiles() {
  const dotenv = require('dotenv');
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '..', '.env')];
  const loaded = [];
  for (const file of [...new Set(candidates)]) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
      loaded.push(file);
    }
  }
  return loaded;
}

module.exports = { loadEnvFiles };
