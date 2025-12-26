import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase';
import { r2Client, BUCKET_NAME } from '../services/r2';
import { PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});
const jobQueue = new Queue('job-queue', { connection });

// 1. 获取所有工具
router.get('/tools', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('photo_tools').select('*').eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 2. 创建任务
router.post('/jobs', authenticate, async (req: AuthRequest, res) => {
  const { toolId } = req.body;
  const userId = req.user?.id;

  const { data, error } = await supabaseAdmin
    .from('jobs')
    .insert({ user_id: userId, tool_id: toolId, status: 'pending' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 3. 获取上传预签名 URL
router.post('/jobs/:jobId/presign-upload', authenticate, async (req: AuthRequest, res) => {
  const { jobId } = req.params;
  const { files } = req.body; // [{ name: string, type: string }]
  const userId = req.user?.id;

  const results = await Promise.all(files.map(async (file: any) => {
    const assetId = uuidv4();
    const ext = file.name.split('.').pop();
    const r2Key = `u/${userId}/jobs/${jobId}/raw/${assetId}.${ext}`;
    
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: r2Key,
      ContentType: file.type
    });

    const putUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });
    
    // 预写入 asset 记录
    await supabaseAdmin.from('job_assets').insert({
        id: assetId,
        job_id: jobId,
        r2_key: r2Key,
        status: 'pending'
    });

    return { assetId, r2Key, putUrl };
  }));

  res.json(results);
});

// 4. 提交任务 (校验并入队)
router.post('/jobs/:jobId/commit', authenticate, async (req: AuthRequest, res) => {
  const { jobId } = req.params;
  const userId = req.user?.id;

  // 1. 验证 job 属于该用户
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();

  if (jobErr || !job) return res.status(404).json({ error: 'Job not found' });

  // 2. 获取并校验 assets
  const { data: assets } = await supabaseAdmin.from('job_assets').select('*').eq('job_id', jobId);
  
  if (!assets || assets.length === 0) return res.status(400).json({ error: 'No assets found' });

  // 3. 更新状态并入队
  await supabaseAdmin.from('jobs').update({ status: 'queued' }).eq('id', jobId);
  
  await jobQueue.add('process-job', { jobId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }
  });

  res.json({ message: 'Job queued', jobId });
});

// 5. 获取任务进度
router.get('/jobs/:jobId', authenticate, async (req: AuthRequest, res) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    const { data: job, error } = await supabaseAdmin
        .from('jobs')
        .select('*, photo_tools(*), job_assets(*)')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();

    if (error) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// 6. 获取下载预签名 URL
router.post('/jobs/:jobId/presign-download', authenticate, async (req: AuthRequest, res) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    const { data: job } = await supabaseAdmin
        .from('jobs')
        .select('*')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();

    if (!job || !job.zip_key) return res.status(400).json({ error: 'ZIP not ready or job not found' });

    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: job.zip_key
    });

    const url = await getSignedUrl(r2Client, command, { expiresIn: 900 });
    res.json({ url });
});

// 7. 分页获取历史任务
router.get('/jobs', authenticate, async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    const { page = 1, limit = 10 } = req.query;
    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    const { data, error, count } = await supabaseAdmin
        .from('jobs')
        .select('*, photo_tools(name)', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data, count });
});

// 8. 获取个人资料 (含积分)
router.get('/profile', authenticate, async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
    
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 9. 充值积分 (模拟实现)
router.post('/recharge', authenticate, async (req: AuthRequest, res) => {
    const userId = req.user?.id;
    const { amount } = req.body; // 假设前端传充值点数

    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // 1. 更新积分
    const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('points')
        .eq('id', userId)
        .single();
    
    const newPoints = (profile?.points || 0) + amount;

    await supabaseAdmin
        .from('profiles')
        .update({ points: newPoints })
        .eq('id', userId);
    
    // 2. 记录流水
    await supabaseAdmin.from('transactions').insert({
        user_id: userId,
        amount: amount,
        type: 'recharge',
        description: `Recharged ${amount} points`
    });

    res.json({ points: newPoints });
});

export default router;
