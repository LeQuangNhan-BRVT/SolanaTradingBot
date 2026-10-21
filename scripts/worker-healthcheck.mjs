import Redis from "ioredis";
const redis=new Redis(process.env.REDIS_URL??"redis://redis:6379",{maxRetriesPerRequest:1,connectTimeout:2000});
try{const ttl=await redis.ttl("aegis:worker:heartbeat");await redis.quit();process.exit(ttl>0?0:1);}catch{redis.disconnect();process.exit(1);}
