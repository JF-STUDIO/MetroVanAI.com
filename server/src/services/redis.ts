import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new (IORedis as any)(REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
        return Math.min(times * 50, 2000);
    },
    reconnectOnError(err: Error) {
        const targetError = 'READONLY';
        if (err.message.slice(0, targetError.length) === targetError) {
            return true;
        }
        return false;
    }
});

redisConnection.on('error', (err: Error) => {
    console.error('Shared Redis connection error:', err.message);
});

redisConnection.on('connect', () => {
    console.log('Shared Redis connection established');
});

redisConnection.on('ready', () => {
    console.log('Shared Redis connection ready for operations');
});
