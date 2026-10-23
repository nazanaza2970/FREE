import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Database } from '../server/sqlite';

const token = process.argv[2] ?? 'tfp_' + randomBytes(32).toString('base64url');
const dbPath = process.argv[3] ?? path.resolve('data/termius.db');

const db = new Database(dbPath);
db.prepare('INSERT INTO app_passwords (name, scope, token_hash) VALUES (?, ?, ?)').run(
  'recovery',
  '*',
  createHash('sha256').update(token).digest('hex'),
);
db.close();
console.log('Token inserted. Paste this into the lock screen:');
console.log(token);
