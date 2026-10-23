import { beforeAll } from 'vitest';
import { migrate } from '../src/migrate';
import { seed } from '../src/seed';

beforeAll(async () => {
  await migrate();
  await seed();
});
