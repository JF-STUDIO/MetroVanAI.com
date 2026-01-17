import './config.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jobRoutes from './routes/jobs.js';
import workflowRoutes from './routes/workflows.js';
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import { createRedis } from './services/redis.js';
import webhookRoutes from './routes/webhooks.js';

const app = express();
const port = process.env.PORT || 4000;

// Avoid 304 caching for polling endpoints (keep status updates fresh).
app.set('etag', false);

const defaultOrigins = [
  'https://metro-van-ai-com.vercel.app',
  'https://metrovanai.com',
  'https://www.metrovanai.com'
];

console.log('--- ENV CHECK ---');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'MISSING');
console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING');
console.log('-----------------');
const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, '');
const rawOrigins = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '';
const envOrigins = rawOrigins
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);
const localOrigins = ['http://localhost:5173', 'http://localhost:3000'];
const finalAllowedOrigins = Array.from(new Set([...defaultOrigins, ...envOrigins, ...localOrigins].map(normalizeOrigin)));
const allowAllOrigins = finalAllowedOrigins.includes('*');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    if (allowAllOrigins || finalAllowedOrigins.includes(normalized)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  // Explicitly allow auth headers used by Supabase/axios to avoid preflight failure.
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'apikey',
    'x-client-info',
    'x-supabase-auth',
    'x-supabase-api-version'
  ],
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']
}));
app.use(morgan('dev'));
app.use(express.json());

// 路由
app.use('/api', jobRoutes);
app.use('/api', workflowRoutes);
app.use('/api', adminRoutes);
app.use('/api', settingsRoutes);
app.use('/api/webhooks', webhookRoutes);

const inlineWorkerEnabled = process.env.ENABLE_INLINE_WORKER === 'true';
console.log(`Inline worker enabled: ${inlineWorkerEnabled ? 'true' : 'false'}`);
if (inlineWorkerEnabled) {
  console.log('Starting inline worker...');
  import('./worker.js').catch((error) => {
    console.error('Failed to start inline worker:', error);
  });
}

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
