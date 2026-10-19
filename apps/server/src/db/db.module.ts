import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { join } from "node:path";
import { APP_CONFIG, type AppConfig } from "../config";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export const DB = Symbol("DB");
const POOL = Symbol("POOL");

export const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

@Global()
@Module({
  providers: [
    {
      provide: POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new Pool({ connectionString: config.databaseUrl }),
    },
    {
      provide: DB,
      inject: [POOL],
      useFactory: async (pool: Pool) => {
        const db = drizzle(pool, { schema });
        await runMigrations(db);
        return db;
      },
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
