import IORedis from 'ioredis';

/**
 * Creates a new Redis client instance.
 * This factory function ensures that each part of the application (Queue, Worker, etc.)
 * gets its own Redis connection, preventing issues with shared connections.
 * It also enforces the use of REDIS_URL from environment variables and enables TLS,
 * which is required for services like Upstash.
 */
export function createRedis() {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL environment variable is not set.');
  }

  // Configuration for Upstash Redis or any other cloud Redis that requires TLS
  const redisOptions = {
    tls: {}, // Enable TLS
    maxRetriesPerRequest: null, // From user's instruction
    enableReadyCheck: false, // From user's instruction
    keepAlive: 30000, // From user's instruction
  };

  const client = new (IORedis as any)(process.env.REDIS_URL, redisOptions);

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
