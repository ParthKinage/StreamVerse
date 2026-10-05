import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx src/seed.ts' },
  datasource: {
    // A placeholder keeps `prisma generate` working before .env exists; migrate commands need the real value.
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/tesor_gp?schema=public',
  },
});
