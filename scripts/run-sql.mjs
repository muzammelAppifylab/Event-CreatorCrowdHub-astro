// Runs a .sql file against DATABASE_URL: `node --env-file=.env scripts/run-sql.mjs prisma/seed-events.sql`
import {readFileSync} from 'node:fs';
import pg from 'pg';

const [file] = process.argv.slice(2);
if (!file || !process.env.DATABASE_URL) throw new Error('Usage: node --env-file=.env scripts/run-sql.mjs <file.sql>');
const client = new pg.Client({connectionString: process.env.DATABASE_URL});
await client.connect();
try {
  await client.query(readFileSync(file, 'utf8'));
  console.log(`Applied ${file}`);
} finally {
  await client.end();
}
