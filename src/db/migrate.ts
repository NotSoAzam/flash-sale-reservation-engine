import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  console.log('🚀 Running database migrations...');
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).sort();

  for (const file of files) {
    if (file.endsWith('.sql')) {
      const filePath = path.join(migrationsDir, file);
      console.log(`📄 Executing migration: ${file}`);
      const sql = fs.readFileSync(filePath, 'utf-8');
      await pool.query(sql);
    }
  }
  console.log('✅ All migrations executed successfully.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('❌ Migration failed:', err);
      await pool.end();
      process.exit(1);
    });
}
