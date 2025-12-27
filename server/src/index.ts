import './config.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jobRoutes from './routes/jobs.js';

const app = express();
const port = process.env.PORT || 4000;

const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json());

// 路由
app.use('/api', jobRoutes);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
