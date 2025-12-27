import IORedis from 'ioredis';

/**
 * Creates a new Redis client instance.
 * This factory function ensures that each part of the application (Queue, Worker, etc.)
 * gets its own Redis connection, preventing issues with shared connections.
 * It also enforces the use of REDIS_URL from environment variables and enables TLS,
 * which is required for services like Upstash.
 */
export function createRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is not set.');
  }
  
  // Log the Redis host to confirm the correct URL is being used, without exposing the password.
  let hostLabel = 'unknown';
  try {
    hostLabel = new URL(redisUrl).host;
  } catch {
    hostLabel = redisUrl.split('@').pop() || 'unknown';
  }
  console.log(`Connecting to Redis at ${hostLabel}...`);

  const useTls = redisUrl.startsWith('rediss://') || process.env.REDIS_TLS === 'true';

  // Configuration for Redis; only enable TLS when required.
  const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    keepAlive: 30000,
    ...(useTls ? { tls: {} } : {}),
  };

  const client = new (IORedis as any)(redisUrl, redisOptions);

  client.on('error', (err: Error) => {
    console.error('Redis client error:', err);
  });

  client.on('connect', () => {
    console.log('Redis client connected.');
  });

  client.on('ready', () => {
    console.log('Redis client ready.');
  });

  client.on('close', () => {
    console.log('Redis client connection closed.');
  });

  client.on('reconnecting', () => {
    console.log('Redis client reconnecting...');
  });

  return client;
}
