import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Database = ReturnType<typeof drizzle<typeof schema>>;
let cached: Database | undefined;

export function hasDatabase() { return Boolean(process.env.DATABASE_URL); }
export function getDatabase(): Database {
  if (cached) return cached;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL chưa được cấu hình.");
  const client = postgres(process.env.DATABASE_URL, { max: 10, idle_timeout: 20, connect_timeout: 10, prepare: false });
  cached = drizzle(client, { schema });
  return cached;
}
