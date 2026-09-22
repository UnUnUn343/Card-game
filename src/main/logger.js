'use strict';
/** Tiny file logger: <userData>/logs/main.log, rolled over to main.old.log at 1 MB. */
const fs = require('fs');
const path = require('path');

function createLogger(dir) {
  const file = path.join(dir, 'main.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, path.join(dir, 'main.old.log'));
  } catch {}
  const log = (...parts) => {
    const line = `[${new Date().toISOString()}] ${parts.map(p => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
    if (!process.env.PKMN_QUIET) console.log(line);
    try { fs.appendFileSync(file, line + '\n'); } catch {}
  };
  log.file = file;
  return log;
}

module.exports = { createLogger };
