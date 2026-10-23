import { buildApp } from './app';
import { config } from './config';
import { pool } from './db';

async function main() {
  const app = buildApp();

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
