import './config.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jobRoutes from './routes/jobs.js';
import './worker.js'; // Start the worker in the same process
import { createRedis } from './services/redis.js';

const app = express();
const port = process.env.PORT || 4000;


const allowedOrigins = [
  'https://metro-van-ai-com.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    // allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());

// 路由
app.use('/api', jobRoutes);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Redis 健康检查
app.get('/api/health-redis', async (req, res) => {
  let redisClient;
  try {
    console.log('Attempting to create Redis client for health check...');
    redisClient = createRedis();
    console.log('Pinging Redis...');
    const pong = await redisClient.ping();
    console.log('Redis ping successful:', pong);
    res.json({ status: 'ok', message: 'Redis connection successful.', pong });
  } catch (error) {
    console.error('Redis health check failed:', error);
    res.status(500).json({ status: 'error', message: 'Failed to connect to Redis.', error: (error as Error).message });
  } finally {
    if (redisClient) {
      redisClient.quit();
    }
  }
});


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
