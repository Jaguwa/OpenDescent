#!/usr/bin/env node
/**
 * Generate SHA-256 checksums for the built installers in release/.
 * Writes release/SHA256SUMS.txt in the standard `<hash>  <filename>` format
 * (so `sha256sum -c SHA256SUMS.txt` works on Linux/macOS), to publish
 * alongside each GitHub release so users can verify their download.
 *
 * Usage:  npm run checksums      (run after `npm run dist`)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE_DIR = 'release';
if (!existsSync(RELEASE_DIR)) {
  console.error(`No ${RELEASE_DIR}/ directory — run "npm run dist" first.`);
  process.exit(1);
}

const targets = readdirSync(RELEASE_DIR)
  .filter((f) => /\.(exe|dmg|AppImage|deb|rpm|zip)$/i.test(f))
  .sort();

if (targets.length === 0) {
  console.error(`No installer artifacts found in ${RELEASE_DIR}/.`);
  process.exit(1);
}

const lines = [];
for (const file of targets) {
  const hash = createHash('sha256').update(readFileSync(join(RELEASE_DIR, file))).digest('hex');
  lines.push(`${hash}  ${file}`);
  console.log(`${hash}  ${file}`);
}

const out = join(RELEASE_DIR, 'SHA256SUMS.txt');
writeFileSync(out, lines.join('\n') + '\n');
console.log(`\nWrote ${out} (${targets.length} file${targets.length === 1 ? '' : 's'}).`);
console.log('Publish this file with the GitHub release so users can verify their download.');
