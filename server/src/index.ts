import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import jobRoutes from './routes/jobs';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], // Allow frontend
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());
app.use(morgan('dev'));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API 路由
app.use('/api', jobRoutes);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
