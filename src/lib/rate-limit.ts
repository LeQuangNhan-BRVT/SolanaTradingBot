import IORedis from "ioredis";

let redis: IORedis | undefined;
const localWindows = new Map<string, { count: number; resetAt: number }>();

function client() {
  redis ??= new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1_500 });
  return redis;
}

export async function checkRateLimit(key: string, limit: number, windowSeconds: number) {
  try {
    const connection = client();
    if (connection.status === "wait") await connection.connect();
    const redisKey = `aegis:rate:${key}`;
    const count = await connection.incr(redisKey);
    if (count === 1) await connection.expire(redisKey, windowSeconds);
    const ttl = Math.max(await connection.ttl(redisKey), 1);
    return { allowed: count <= limit, remaining: Math.max(limit - count, 0), retryAfter: ttl };
  } catch {
    const now = Date.now();
    const current = localWindows.get(key);
    const window = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowSeconds * 1000 } : current;
    window.count += 1;
    localWindows.set(key, window);
    return { allowed: window.count <= limit, remaining: Math.max(limit - window.count, 0), retryAfter: Math.max(Math.ceil((window.resetAt - now) / 1000), 1) };
  }
}

export function requestClientId(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}
