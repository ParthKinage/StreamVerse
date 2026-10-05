import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export * from './generated/client';

/** Creates a PrismaClient using the pure-JS pg driver adapter (no native query engine). */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');
  const adapter = new PrismaPg({ connectionString: url.toString() }, schema ? { schema } : undefined);
  return new PrismaClient({ adapter });
}

let singleton: PrismaClient | undefined;

/** Process-wide Prisma client. Only apps/api and the seed script may call this. */
export function getPrisma(databaseUrl: string | undefined = process.env.DATABASE_URL): PrismaClient {
  if (!singleton) {
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    singleton = createPrismaClient(databaseUrl);
  }
  return singleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = undefined;
  }
}
