import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { supabaseAdmin } from '../services/supabase.js';
import { r2Client, BUCKET_NAME } from '../services/r2.js';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types/auth.js';
import { createRedis } from '../services/redis.js';

const router = Router();

// Create a new Redis connection for the queue.
const jobQueue = new Queue('job-queue', { connection: createRedis() });

// 1. 获取所有工具
router.get('/tools', async (req: Request, res: Response) => {
  const { data, error } = await (supabaseAdmin.from('photo_tools') as any).select('*').eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 2. 创建任务
router.post('/jobs', authenticate, async (req: AuthRequest, res: Response) => {
  console.log('Received /api/jobs request:', req.body);
  const { toolId, projectName } = req.body;
  const userId = req.user?.id;

  if (!projectName) {
    console.error('Project name is missing');
    return res.status(400).json({ error: 'Project name is required' });
  }
  if (!toolId) {
    console.error('Tool ID is missing');
    return res.status(400).json({ error: 'Tool ID is required' });
  }

  try {
    const { data, error } = await (supabaseAdmin
      .from('jobs') as any)
      .insert({ user_id: userId, tool_id: toolId, project_name: projectName, status: 'pending' })
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: error.message });
    }
    
    console.log('Job created successfully:', data);
    res.json(data);
  } catch (e) {
    console.error('Catch block error in /api/jobs:', e);
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
});

// 3. 获取上传预签名 URL
router.post('/jobs/:jobId/presign-upload', authenticate, async (req: AuthRequest, res: Response) => {
  const { jobId } = req.params;
  const { files }: { files: {name: string, type: string}[] } = req.body;
  const userId = req.user?.id;

  const results = await Promise.all(files.map(async (file) => {
    const assetId = uuidv4();
    const ext = file.name.split('.').pop() || '';
    const r2Key = `u/${userId}/jobs/${jobId}/raw/${assetId}.${ext}`;
    
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: r2Key,
      ContentType: file.type
    });

    const putUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });
    
    await (supabaseAdmin.from('job_assets') as any).insert({
        id: assetId,
        job_id: jobId,
        r2_key: r2Key,
        status: 'pending'
    });

    return { assetId, r2Key, putUrl, fileName: file.name };
  }));

  res.json(results);
});

// 4. 提交任务 (校验并入队)
router.post('/jobs/:jobId/commit', authenticate, async (req: AuthRequest, res: Response) => {
  const { jobId } = req.params;
  const userId = req.user?.id;

  const { data: job, error: jobErr } = await (supabaseAdmin
    .from('jobs') as any).select('*').eq('id', jobId).eq('user_id', userId).single();
  if (jobErr || !job) return res.status(404).json({ error: 'Job not found' });

  const { data: assets } = await (supabaseAdmin.from('job_assets') as any).select('*').eq('job_id', jobId);
  if (!assets || assets.length === 0) return res.status(400).json({ error: 'No assets found' });

  await (supabaseAdmin.from('jobs') as any).update({ status: 'queued' }).eq('id', jobId);
  
  await jobQueue.add('process-job', { jobId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }
  });

  res.json({ message: 'Job queued', jobId });
});

// 5. 获取任务进度
router.get('/jobs/:jobId', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    const { data: job, error } = await (supabaseAdmin
        .from('jobs') as any).select('*, photo_tools(*), job_assets(*)').eq('id', jobId).eq('user_id', userId).single();
    if (error) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// 6. 获取下载预签名 URL
router.post('/jobs/:jobId/presign-download', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    const { data: job } = await (supabaseAdmin
        .from('jobs') as any).select('*').eq('id', jobId).eq('user_id', userId).single();
    if (!job || !job.zip_key) return res.status(400).json({ error: 'ZIP not ready or job not found' });

    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: job.zip_key });
    const url = await getSignedUrl(r2Client, command, { expiresIn: 900 });
    res.json({ url });
});

// 7. 分页获取历史任务
router.get('/jobs', authenticate, async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { page = 1, limit = 10 } = req.query as any;
    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    const { data, error, count } = await (supabaseAdmin
        .from('jobs') as any).select('*, photo_tools(name)', { count: 'exact' }).eq('user_id', userId).order('created_at', { ascending: false }).range(from, to);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ data, count });
});

// 8. 获取个人资料 (含积分)
router.get('/profile', authenticate, async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { data, error } = await (supabaseAdmin.from('profiles') as any).select('*').eq('id', userId).single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 9. 充值积分 (模拟实现)
router.post('/recharge', authenticate, async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { amount } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const { data: profile } = await (supabaseAdmin
        .from('profiles') as any).select('points').eq('id', userId).single();
    
    const newPoints = (profile?.points || 0) + amount;

    await (supabaseAdmin.from('profiles') as any).update({ points: newPoints }).eq('id', userId);
    
    await (supabaseAdmin.from('transactions') as any).insert({
        user_id: userId, amount: amount, type: 'recharge', description: `Recharged ${amount} points`
    });

    res.json({ points: newPoints });
});

export default router;
