import { redis } from "./redisClient.js";
// export const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours  
export async function getOrSetCache(key, ttlSeconds, fetcher) {
    const cached = await redis.get(key);
  
    if (cached) {
      return JSON.parse(cached);
    }
  
    const freshData = await fetcher();
  
    await redis.set(key, JSON.stringify(freshData), {
      EX: ttlSeconds,
    });
  
    return freshData;
  }