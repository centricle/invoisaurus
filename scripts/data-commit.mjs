/**
 * Commit the data directory, for setups where it is a git repo of its own.
 *
 * A repo nested inside a path the parent ignores is invisible to the parent, so
 * `git status` in this repo will never mention an uncommitted invoice. This
 * script is the counterweight for anyone who keeps the data that way. It commits
 * nothing and exits with an error if the directory is not a git repo.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';

const git = (...args) => execFileSync('git', ['-C', DATA_DIR, ...args], { encoding: 'utf8' });

if (!fs.existsSync(path.join(DATA_DIR, '.git'))) {
  console.error(`No git repo at ${DATA_DIR}.\nInitialize it: git -C "${DATA_DIR}" init`);
  process.exit(1);
}

const status = git('status', '--porcelain').trim();
if (!status) {
  console.log('Data directory is clean. Nothing to commit.');
  process.exit(0);
}

git('add', '-A');
git('commit', '-m', process.argv[2] || `Update invoice data ${new Date().toISOString().slice(0, 10)}`);
console.log(git('log', '-1', '--oneline').trim());
console.log(`\nCommitted in ${DATA_DIR}. Push separately when you have a remote.`);
