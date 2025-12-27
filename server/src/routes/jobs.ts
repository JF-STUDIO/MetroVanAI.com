import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { supabaseAdmin } from '../services/supabase.js';
import { r2Client, BUCKET_NAME, RAW_BUCKET, getPresignedPutUrl } from '../services/r2.js';
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
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await (supabaseAdmin.from('profiles') as any).select('*').eq('id', userId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    if (!data) {
        const fallbackProfile = {
            id: userId,
            email: req.user?.email || null,
            points: 10,
            is_admin: false
        };
        const { data: created, error: createError } = await (supabaseAdmin.from('profiles') as any)
            .upsert(fallbackProfile)
            .select()
            .single();
        if (createError) return res.status(500).json({ error: createError.message });
        return res.json(created);
    }

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

// New pipeline: presign raw uploads (mvai-raw bucket)
router.post('/jobs/:jobId/presign-raw', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const { files }: { files: { name: string; type: string }[] } = req.body || {};
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files required' });

    const { data: job } = await (supabaseAdmin
        .from('jobs') as any).select('id').eq('id', jobId).eq('user_id', userId).single();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const results = await Promise.all(files.map(async (file) => {
        const assetId = uuidv4();
        const ext = file.name.split('.').pop() || '';
        const r2Key = `u/${userId}/jobs/${jobId}/raw/${assetId}.${ext}`;
        const putUrl = await getPresignedPutUrl(RAW_BUCKET, r2Key, file.type || 'application/octet-stream');
        return { fileName: file.name, r2Key, putUrl };
    }));

    res.json(results);
});

// New pipeline: confirm upload and register raw files
router.post('/jobs/:jobId/upload-complete', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const { files } = req.body || {};
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files required' });

    const { data: job } = await (supabaseAdmin
        .from('jobs') as any).select('id, status').eq('id', jobId).eq('user_id', userId).single();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const rows = files.map((file: any) => ({
        job_id: jobId,
        r2_bucket: file.r2_bucket || RAW_BUCKET,
        r2_key: file.r2_key || file.r2Key || file.key,
        filename: file.filename || file.name,
        exif_time: file.exif_time || null,
        size: file.size || null,
        camera_make: file.camera_make || null,
        camera_model: file.camera_model || null
    })).filter((row: any) => row.r2_key);

    if (rows.length === 0) return res.status(400).json({ error: 'No valid file keys provided' });

    const { error: insertError } = await (supabaseAdmin.from('job_files') as any)
        .upsert(rows, { onConflict: 'job_id,r2_key' });
    if (insertError) return res.status(500).json({ error: insertError.message });

    await (supabaseAdmin.from('jobs') as any)
        .update({ status: 'uploaded' })
        .eq('id', jobId)
        .eq('user_id', userId);

    res.json({ uploaded: rows.length });
});

// New pipeline: analyze and group files
router.post('/jobs/:jobId/analyze', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: job } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, status')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    await (supabaseAdmin.from('jobs') as any)
        .update({ status: 'analyzing' })
        .eq('id', jobId)
        .eq('user_id', userId);

    const { data: files, error: filesError } = await (supabaseAdmin.from('job_files') as any)
        .select('id, r2_key, exif_time')
        .eq('job_id', jobId);
    if (filesError) return res.status(500).json({ error: filesError.message });
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files to analyze' });

    const sorted = [...files].sort((a: any, b: any) => {
        if (a.exif_time && b.exif_time) {
            return new Date(a.exif_time).getTime() - new Date(b.exif_time).getTime();
        }
        if (!a.exif_time && b.exif_time) return -1;
        if (a.exif_time && !b.exif_time) return 1;
        return 0;
    });

    const thresholdMs = 2000;
    const groups: any[][] = [];
    let current: any[] = [];

    for (const file of sorted) {
        if (!file.exif_time) {
            if (current.length > 0) {
                groups.push(current);
                current = [];
            }
            groups.push([file]);
            continue;
        }

        if (current.length === 0) {
            current.push(file);
            continue;
        }

        const last = current[current.length - 1];
        if (!last.exif_time) {
            groups.push(current);
            current = [file];
            continue;
        }

        const delta = Math.abs(new Date(file.exif_time).getTime() - new Date(last.exif_time).getTime());
        if (delta <= thresholdMs) {
            current.push(file);
        } else {
            groups.push(current);
            current = [file];
        }
    }

    if (current.length > 0) groups.push(current);

    await (supabaseAdmin.from('job_groups') as any)
        .delete()
        .eq('job_id', jobId);

    const groupRows = groups.map((group, index) => ({
        id: uuidv4(),
        job_id: jobId,
        group_index: index + 1,
        raw_count: group.length,
        status: 'queued'
    }));

    const { error: groupError } = await (supabaseAdmin.from('job_groups') as any)
        .insert(groupRows);
    if (groupError) return res.status(500).json({ error: groupError.message });

    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const groupId = groupRows[index].id;
        const ids = group.map(item => item.id);
        await (supabaseAdmin.from('job_files') as any)
            .update({ group_id: groupId })
            .in('id', ids);
    }

    await (supabaseAdmin.from('jobs') as any)
        .update({ status: 'uploaded', estimated_units: groupRows.length, progress: 0 })
        .eq('id', jobId)
        .eq('user_id', userId);

    res.json({ estimated_units: groupRows.length });
});

// New pipeline: reserve credits and enqueue job
router.post('/jobs/:jobId/start', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: job, error: jobError } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, status, estimated_units, reserved_units, workflow_id')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();
    if (jobError || !job) return res.status(404).json({ error: 'Job not found' });
    if (!job.estimated_units || job.estimated_units <= 0) return res.status(400).json({ error: 'Analyze job first' });

    const { data: workflow, error: workflowError } = await (supabaseAdmin
        .from('workflows') as any)
        .select('credit_per_unit')
        .eq('id', job.workflow_id)
        .single();
    if (workflowError || !workflow) return res.status(400).json({ error: 'Workflow not found' });

    const creditsToReserve = job.estimated_units * workflow.credit_per_unit;
    const idempotencyKey = `reserve:${jobId}`;

    const { data: balance, error: reserveError } = await (supabaseAdmin as any)
        .rpc('credit_reserve', {
            p_user_id: userId,
            p_job_id: jobId,
            p_units: creditsToReserve,
            p_idempotency_key: idempotencyKey,
            p_note: 'Reserve credits for job'
        });

    if (reserveError) {
        const message = reserveError.message || 'Failed to reserve credits';
        const status = message.includes('insufficient credits') ? 402 : 500;
        return res.status(status).json({ error: message });
    }

    await (supabaseAdmin.from('jobs') as any)
        .update({
            status: 'reserved',
            reserved_units: job.estimated_units
        })
        .eq('id', jobId)
        .eq('user_id', userId);

    res.json({ reserved_units: job.estimated_units, credits_reserved: creditsToReserve, balance });
});

// New pipeline: create job from workflow
router.post('/jobs/create', authenticate, async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { workflowId, workflowSlug, projectName } = req.body || {};

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!workflowId && !workflowSlug) {
        return res.status(400).json({ error: 'workflowId or workflowSlug is required' });
    }

    let workflowQuery = (supabaseAdmin.from('workflows') as any)
        .select('id, credit_per_unit, is_active');
    if (workflowId) {
        workflowQuery = workflowQuery.eq('id', workflowId);
    } else {
        workflowQuery = workflowQuery.eq('slug', workflowSlug);
    }

    const { data: workflow, error: workflowError } = await workflowQuery.single();
    if (workflowError || !workflow || !workflow.is_active) {
        return res.status(404).json({ error: 'Workflow not found or inactive' });
    }

    const { data: version, error: versionError } = await (supabaseAdmin.from('workflow_versions') as any)
        .select('id, version')
        .eq('workflow_id', workflow.id)
        .eq('is_published', true)
        .single();
    if (versionError || !version) {
        return res.status(400).json({ error: 'No published workflow version' });
    }

    const { data: job, error: jobError } = await (supabaseAdmin
        .from('jobs') as any)
        .insert({
            user_id: userId,
            workflow_id: workflow.id,
            workflow_version_id: version.id,
            project_name: projectName || null,
            status: 'draft'
        })
        .select()
        .single();

    if (jobError) return res.status(500).json({ error: jobError.message });
    res.json(job);
});

// New pipeline: job status
router.get('/jobs/:jobId/status', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: job, error } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, status, estimated_units, reserved_units, settled_units, progress, zip_key, created_at, project_name')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();
    if (error || !job) return res.status(404).json({ error: 'Job not found' });

    const { data: groups } = await (supabaseAdmin.from('job_groups') as any)
        .select('status')
        .eq('job_id', jobId);

    const summary = (groups || []).reduce((acc: any, group: any) => {
        acc.total += 1;
        if (group.status === 'ai_ok') acc.success += 1;
        if (group.status === 'failed') acc.failed += 1;
        return acc;
    }, { total: 0, success: 0, failed: 0 });

    res.json({ job, groups: summary });
});

export default router;
