import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { supabaseAdmin } from '../services/supabase.js';
import { r2Client, BUCKET_NAME, RAW_BUCKET, HDR_BUCKET, OUTPUT_BUCKET, getPresignedPutUrl, getPresignedGetUrl } from '../services/r2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types/auth.js';
import { createRedis } from '../services/redis.js';
import { extractExifFromR2 } from '../services/exif.js';

const router = Router();

// Create a new Redis connection for the queue.
const jobQueue = new Queue('job-queue', { connection: createRedis() });

const runWithConcurrency = async <T>(
    items: T[],
    limit: number,
    handler: (item: T) => Promise<void>
) => {
    if (!items.length) return;
    const queue = [...items];
    const workers = Array.from({ length: Math.max(limit, 1) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) return;
            await handler(item);
        }
    });
    await Promise.all(workers);
};

const exposurePlan = (count: number) => {
    const sizes = [7, 5, 3];
    const memo = new Map<number, number[]>();
    const best = (remaining: number): number[] => {
        if (memo.has(remaining)) return memo.get(remaining)!;
        let bestSizes: number[] = [];
        let bestUsed = 0;
        for (const size of sizes) {
            if (remaining < size) continue;
            const candidate = [size, ...best(remaining - size)];
            const used = candidate.reduce((sum, value) => sum + value, 0);
            if (used > bestUsed) {
                bestUsed = used;
                bestSizes = candidate;
            }
        }
        memo.set(remaining, bestSizes);
        return bestSizes;
    };
    const chosen = best(count);
    const used = chosen.reduce((sum, value) => sum + value, 0);
    return { sizes: chosen, remainder: count - used };
};

const RAW_EXTENSIONS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'rw2', 'orf']);
const JPG_EXTENSIONS = new Set(['jpg', 'jpeg']);
const PNG_EXTENSIONS = new Set(['png']);

const detectInputKind = (filename?: string | null, key?: string | null) => {
    const source = filename || key || '';
    const ext = source.split('.').pop()?.toLowerCase() || '';
    if (RAW_EXTENSIONS.has(ext)) return 'raw';
    if (JPG_EXTENSIONS.has(ext)) return 'jpg';
    if (PNG_EXTENSIONS.has(ext)) return 'png';
    return 'other';
};

const normalizeOutputFilename = (filename?: string | null, fallback = 'image') => {
    const base = (filename || fallback).replace(/\.[^.]+$/, '');
    return `${base}.jpg`;
};

const scoreTime = (files: any[]) => {
    const timestamps = files
        .map(file => file.exif_time ? new Date(file.exif_time).getTime() : null)
        .filter((value: number | null) => value !== null) as number[];
    if (timestamps.length < files.length) return 0;
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    const delta = max - min;
    if (delta <= 2000) return 0.4;
    if (delta >= 6000) return 0;
    const factor = 1 - (delta - 2000) / 4000;
    return 0.4 * Math.max(0, Math.min(1, factor));
};

const scoreExposureSteps = (files: any[]) => {
    const evs = files
        .map(file => typeof file.ev === 'number' ? file.ev : null)
        .filter((value: number | null) => value !== null) as number[];
    if (evs.length < 2) return 0;
    const sorted = [...evs].sort((a, b) => b - a);
    const diffs = sorted.slice(1).map((value, index) => Math.abs(value - sorted[index]));
    if (diffs.length === 0) return 0;

    const scoreForTarget = (target: number) => {
        const matches = diffs.filter(diff => Math.abs(diff - target) <= 0.3).length;
        return matches / diffs.length;
    };

    const best = Math.max(scoreForTarget(1), scoreForTarget(2));
    return 0.35 * best;
};

const scoreParams = (files: any[]) => {
    const isoValues = files.map(file => file.iso).filter((value: number | null) => typeof value === 'number');
    if (isoValues.length < files.length) return 0;
    const first = isoValues[0];
    const sameIso = isoValues.every(value => Math.abs(value - first) < 0.5);
    return sameIso ? 0.15 : 0;
};

const scoreCamera = (files: any[]) => {
    const make = files[0]?.camera_make || null;
    const model = files[0]?.camera_model || null;
    if (!make || !model) return 0;
    const same = files.every(file => file.camera_make === make && file.camera_model === model);
    return same ? 0.1 : 0;
};

const computeHdrConfidence = (files: any[]) => {
    if (files.length < 2) return 0;
    const score = scoreTime(files) + scoreExposureSteps(files) + scoreParams(files) + scoreCamera(files);
    return Math.max(0, Math.min(1, score));
};

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
const buildDownloadResponse = async (jobId: string, userId: string) => {
    const { data: job } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, workflow_id, zip_key, output_zip_key, output_file_key, output_file_name')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();

    if (!job) return null;

    const bucket = job.workflow_id ? OUTPUT_BUCKET : BUCKET_NAME;
    if (job.output_file_key) {
        const url = await getPresignedGetUrl(bucket, job.output_file_key, 900, job.output_file_name || null);
        return { url, type: 'jpg' };
    }

    const zipKey = job.output_zip_key || job.zip_key;
    if (!zipKey) return null;
    const url = await getPresignedGetUrl(bucket, zipKey, 900);
    return { url, type: 'zip' };
};

router.post('/jobs/:jobId/presign-download', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const payload = await buildDownloadResponse(jobId, userId);
    if (!payload) return res.status(400).json({ error: 'Output not ready or job not found' });
    res.json(payload);
});

router.get('/jobs/:jobId/download', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const payload = await buildDownloadResponse(jobId, userId);
    if (!payload) return res.status(400).json({ error: 'Output not ready or job not found' });
    res.json(payload);
});

// 7. 分页获取历史任务
router.get('/jobs', authenticate, async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { page = 1, limit = 10 } = req.query as any;
    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    const { data, error, count } = await (supabaseAdmin
        .from('jobs') as any)
        .select('*, photo_tools(name), workflows(display_name)', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to);
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

    const { data: credits } = await (supabaseAdmin.from('credit_balances') as any)
        .select('available_credits, reserved_credits')
        .eq('user_id', userId)
        .maybeSingle();

    const availableCredits = credits?.available_credits ?? data.points ?? 0;
    res.json({
        ...data,
        points: availableCredits,
        available_credits: availableCredits,
        reserved_credits: credits?.reserved_credits ?? 0
    });
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

    const rows = files.map((file: any) => {
        const filename = file.filename || file.name;
        return {
            job_id: jobId,
            r2_bucket: file.r2_bucket || RAW_BUCKET,
            r2_key: file.r2_key || file.r2Key || file.key,
            filename,
            input_kind: detectInputKind(filename, file.r2_key || file.r2Key || file.key),
            exif_time: file.exif_time || null,
            size: file.size || null,
            camera_make: file.camera_make || null,
            camera_model: file.camera_model || null
        };
    }).filter((row: any) => row.r2_key);

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
        .select('id, r2_bucket, r2_key, filename, input_kind, exif_time, camera_make, camera_model, size, exposure_time, fnumber, iso, ev')
        .eq('job_id', jobId);
    if (filesError) return res.status(500).json({ error: filesError.message });
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files to analyze' });

    const fileList = [...files];
    const originalFilenames = fileList.map((file: any) => file.filename || file.r2_key.split('/').pop());

    const kindUpdates: { id: string; input_kind: string }[] = [];
    for (const file of fileList) {
        const kind = detectInputKind(file.filename, file.r2_key);
        if (file.input_kind !== kind) {
            file.input_kind = kind;
            kindUpdates.push({ id: file.id, input_kind: kind });
        }
    }
    if (kindUpdates.length > 0) {
        await runWithConcurrency(kindUpdates, 3, async (update) => {
            await (supabaseAdmin.from('job_files') as any)
                .update({ input_kind: update.input_kind })
                .eq('id', update.id);
        });
    }

    const needsExif = fileList.filter((file: any) => file.input_kind === 'raw' && (!file.exif_time || file.ev === null || file.exposure_time === null || file.fnumber === null || file.iso === null));
    if (needsExif.length > 0) {
        await runWithConcurrency(needsExif, 2, async (file: any) => {
            try {
                const meta = await extractExifFromR2(file.r2_bucket || RAW_BUCKET, file.r2_key);
                const updates: Record<string, any> = {};
                if (meta.exif_time) updates.exif_time = meta.exif_time;
                if (meta.camera_make) updates.camera_make = meta.camera_make;
                if (meta.camera_model) updates.camera_model = meta.camera_model;
                if (meta.size) updates.size = meta.size;
                if (meta.exposure_time !== null) updates.exposure_time = meta.exposure_time;
                if (meta.fnumber !== null) updates.fnumber = meta.fnumber;
                if (meta.iso !== null) updates.iso = meta.iso;
                if (meta.ev !== null) updates.ev = meta.ev;

                if (Object.keys(updates).length > 0) {
                    await (supabaseAdmin.from('job_files') as any)
                        .update(updates)
                        .eq('id', file.id);
                    Object.assign(file, updates);
                }
            } catch (error) {
                console.warn('EXIF extraction failed for', file.r2_key, (error as Error).message);
            }
        });
    }

    const rawFiles = fileList.filter((file: any) => file.input_kind === 'raw');
    const imageFiles = fileList.filter((file: any) => file.input_kind === 'jpg' || file.input_kind === 'png');

    const sortedRaw = [...rawFiles].sort((a: any, b: any) => {
        if (a.exif_time && b.exif_time) {
            return new Date(a.exif_time).getTime() - new Date(b.exif_time).getTime();
        }
        if (!a.exif_time && b.exif_time) return -1;
        if (a.exif_time && !b.exif_time) return 1;
        return (a.filename || '').localeCompare(b.filename || '');
    });

    const thresholdMs = 2000;
    const timeGroups: any[][] = [];
    let current: any[] = [];

    for (const file of sortedRaw) {
        if (!file.exif_time) {
            if (current.length > 0) {
                timeGroups.push(current);
                current = [];
            }
            timeGroups.push([file]);
            continue;
        }

        if (current.length === 0) {
            current.push(file);
            continue;
        }

        const last = current[current.length - 1];
        if (!last.exif_time) {
            timeGroups.push(current);
            current = [file];
            continue;
        }

        const delta = Math.abs(new Date(file.exif_time).getTime() - new Date(last.exif_time).getTime());
        if (delta <= thresholdMs) {
            current.push(file);
        } else {
            timeGroups.push(current);
            current = [file];
        }
    }

    if (current.length > 0) timeGroups.push(current);

    const groups: { files: any[]; group_type: string; hdr_confidence: number | null; output_filename: string }[] = [];

    for (const cluster of timeGroups) {
        if (cluster.length < 3) {
            const confidence = computeHdrConfidence(cluster);
            if (cluster.length >= 2 && confidence >= 0.7) {
                const lead = cluster[0];
                groups.push({
                    files: cluster,
                    group_type: 'hdr',
                    hdr_confidence: confidence,
                    output_filename: normalizeOutputFilename(lead.filename, lead.r2_key.split('/').pop() || 'hdr')
                });
            } else {
                for (const file of cluster) {
                    groups.push({
                        files: [file],
                        group_type: 'raw',
                        hdr_confidence: confidence,
                        output_filename: normalizeOutputFilename(file.filename, file.r2_key.split('/').pop() || 'image')
                    });
                }
            }
            continue;
        }

        const { sizes } = exposurePlan(cluster.length);
        let offset = 0;
        for (const size of sizes) {
            const subset = cluster.slice(offset, offset + size);
            offset += size;
            const confidence = computeHdrConfidence(subset);
            if (confidence >= 0.7) {
                const lead = subset[0];
                groups.push({
                    files: subset,
                    group_type: 'hdr',
                    hdr_confidence: confidence,
                    output_filename: normalizeOutputFilename(lead.filename, lead.r2_key.split('/').pop() || 'hdr')
                });
            } else {
                for (const file of subset) {
                    groups.push({
                        files: [file],
                        group_type: 'raw',
                        hdr_confidence: confidence,
                        output_filename: normalizeOutputFilename(file.filename, file.r2_key.split('/').pop() || 'image')
                    });
                }
            }
        }

        const remaining = cluster.length - offset;
        for (let i = 0; i < remaining; i += 1) {
            const file = cluster[offset + i];
            groups.push({
                files: [file],
                group_type: 'raw',
                hdr_confidence: null,
                output_filename: normalizeOutputFilename(file.filename, file.r2_key.split('/').pop() || 'image')
            });
        }
    }

    for (const file of imageFiles) {
        groups.push({
            files: [file],
            group_type: 'image',
            hdr_confidence: null,
            output_filename: normalizeOutputFilename(file.filename, file.r2_key.split('/').pop() || 'image')
        });
    }

    const hdrScores = groups.map(group => group.hdr_confidence || 0);
    const maxHdrConfidence = hdrScores.length ? Math.max(...hdrScores) : null;
    const hasHdr = groups.some(group => group.group_type === 'hdr');
    const inputType = hasHdr ? 'hdr' : groups.length > 1 ? 'batch' : 'single';

    await (supabaseAdmin.from('job_groups') as any)
        .delete()
        .eq('job_id', jobId);

    const groupRows = groups.map((group, index) => ({
        id: uuidv4(),
        job_id: jobId,
        group_index: index + 1,
        raw_count: group.files.filter(file => file.input_kind === 'raw').length,
        status: 'queued',
        group_type: group.group_type,
        hdr_confidence: group.hdr_confidence,
        output_filename: group.output_filename
    }));

    const { error: groupError } = await (supabaseAdmin.from('job_groups') as any)
        .insert(groupRows);
    if (groupError) return res.status(500).json({ error: groupError.message });

    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const groupId = groupRows[index].id;
        const ids = group.files.map((item: any) => item.id);
        await (supabaseAdmin.from('job_files') as any)
            .update({ group_id: groupId })
            .in('id', ids);
    }

    await (supabaseAdmin.from('jobs') as any)
        .update({
            status: 'input_resolved',
            estimated_units: groupRows.length,
            progress: 0,
            input_type: inputType,
            hdr_confidence: maxHdrConfidence,
            original_filenames: originalFilenames
        })
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

    try {
        await jobQueue.add('pipeline-job', { jobId }, {
            jobId: `pipeline:${jobId}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true
        });
    } catch (error) {
        console.warn('Failed to enqueue pipeline job:', (error as Error).message);
    }

    res.json({ reserved_units: job.estimated_units, credits_reserved: creditsToReserve, balance });
});

// New pipeline: retry missing/failed groups
router.post('/jobs/:jobId/retry-missing', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: job, error: jobError } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, workflow_version_id, status')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();
    if (jobError || !job) return res.status(404).json({ error: 'Job not found' });

    const { data: version } = await (supabaseAdmin.from('workflow_versions') as any)
        .select('runtime_config')
        .eq('id', job.workflow_version_id)
        .single();

    const runtimeConfig = (version?.runtime_config || {}) as Record<string, any>;
    const maxAttempts = Number(runtimeConfig.max_attempts ?? 3);

    const { data: groups, error: groupError } = await (supabaseAdmin.from('job_groups') as any)
        .select('id, status, attempts')
        .eq('job_id', jobId);
    if (groupError) return res.status(500).json({ error: groupError.message });

    const retryable = (groups || []).filter((group: any) => (
        group.status === 'failed' && (group.attempts || 0) < maxAttempts
    ));

    if (retryable.length === 0) {
        return res.json({ retried: 0, message: 'No retryable groups' });
    }

    const retryIds = retryable.map((group: any) => group.id);
    const { error: retryError } = await (supabaseAdmin.from('job_groups') as any)
        .update({
            status: 'queued',
            hdr_bucket: null,
            hdr_key: null,
            output_bucket: null,
            output_key: null,
            last_error: null
        })
        .in('id', retryIds);
    if (retryError) return res.status(500).json({ error: retryError.message });

    await (supabaseAdmin.from('jobs') as any)
        .update({ status: 'reserved', progress: 0 })
        .eq('id', jobId)
        .eq('user_id', userId);

    await jobQueue.add('pipeline-job', { jobId }, {
        jobId: `pipeline:${jobId}:retry:${Date.now()}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true
    });

    res.json({ retried: retryIds.length });
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

    const { data: groupRows } = await (supabaseAdmin.from('job_groups') as any)
        .select('id, group_index, status, hdr_bucket, hdr_key, output_bucket, output_key, output_filename, last_error')
        .eq('job_id', jobId)
        .order('group_index', { ascending: true });

    const items = await Promise.all((groupRows || []).map(async (group: any) => {
        const hdrUrl = group.hdr_key
            ? await getPresignedGetUrl(group.hdr_bucket || HDR_BUCKET, group.hdr_key, 900)
            : null;
        const outputUrl = group.output_key
            ? await getPresignedGetUrl(group.output_bucket || OUTPUT_BUCKET, group.output_key, 900)
            : null;
        return {
            id: group.id,
            group_index: group.group_index,
            status: group.status,
            output_filename: group.output_filename,
            hdr_url: hdrUrl,
            output_url: outputUrl,
            last_error: group.last_error || null
        };
    }));

    const progress = typeof job.progress === 'number'
        ? job.progress
        : summary.total > 0
            ? Math.round(((summary.success + summary.failed) / summary.total) * 100)
            : 0;

    res.json({ job, groups: summary, items, progress });
});

export default router;
