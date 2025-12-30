import { Router, Request, Response } from 'express';
import { authenticate, authenticateSse } from '../middleware/auth.js';
import { supabaseAdmin } from '../services/supabase.js';
import { r2Client, BUCKET_NAME, RAW_BUCKET, HDR_BUCKET, OUTPUT_BUCKET, getPresignedPutUrl, getPresignedGetUrl, deletePrefix } from '../services/r2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { AuthRequest } from '../types/auth.js';
import { createRedis } from '../services/redis.js';
import { extractExifFromR2 } from '../services/exif.js';
import { getFreeTrialPoints } from '../services/settings.js';

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
    const sizes = [5, 3, 7];
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
const MAX_UPLOAD_FILES = Number.parseInt(process.env.MAX_UPLOAD_FILES || '0', 10);
const MAX_FILE_BYTES = Number.parseInt(process.env.MAX_FILE_BYTES || `${200 * 1024 * 1024}`, 10);
const MAX_TOTAL_BYTES = Number.parseInt(process.env.MAX_UPLOAD_BYTES || '0', 10);
const SSE_POLL_MS = Number.parseInt(process.env.SSE_POLL_MS || '1000', 10);

const sanitizeFilename = (value: string | null | undefined, fallback = 'image') => {
    const raw = value || fallback;
    const base = path.basename(raw);
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    return safe || fallback;
};

const isSafeKey = (key: string, prefix: string) => {
    if (!key.startsWith(prefix)) return false;
    if (key.includes('..') || key.includes('\\')) return false;
    const rest = key.slice(prefix.length);
    if (!rest || rest.includes('/')) return false;
    return true;
};

const detectInputKind = (filename?: string | null, key?: string | null) => {
    const source = filename || key || '';
    const ext = source.split('.').pop()?.toLowerCase() || '';
    if (RAW_EXTENSIONS.has(ext)) return 'raw';
    if (JPG_EXTENSIONS.has(ext)) return 'jpg';
    if (PNG_EXTENSIONS.has(ext)) return 'png';
    return 'other';
};

const normalizeOutputFilename = (filename?: string | null, fallback = 'image') => {
    const safeName = sanitizeFilename(filename || fallback, fallback);
    const base = safeName.replace(/\.[^.]+$/, '');
    return `${base}.jpg`;
};

const exposureValue = (file: any) => {
    if (typeof file?.ev === 'number' && Number.isFinite(file.ev)) return file.ev;
    if (typeof file?.exposure_time === 'number' && Number.isFinite(file.exposure_time) && file.exposure_time > 0) {
        return Math.log2(file.exposure_time);
    }
    return null;
};

const scoreTime = (files: any[]) => {
    const timestamps = files
        .map(file => file.exif_time ? new Date(file.exif_time).getTime() : null)
        .filter((value: number | null) => value !== null) as number[];
    if (timestamps.length < files.length) return 0;
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    const delta = max - min;
    if (delta <= 3000) return 0.4;
    if (delta >= 9000) return 0;
    const factor = 1 - (delta - 3000) / 6000;
    return 0.4 * Math.max(0, Math.min(1, factor));
};

const scoreExposureSteps = (files: any[]) => {
    const evs = files
        .map(file => exposureValue(file))
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

const evRange = (files: any[]) => {
    const evs = files
        .map(file => exposureValue(file))
        .filter((value: number | null) => value !== null) as number[];
    if (evs.length < 2) return 0;
    return Math.max(...evs) - Math.min(...evs);
};

const extractSequenceToken = (value: string) => {
    const base = path.basename(value || '');
    const match = base.match(/^(.*?)(\d+)(\.[^.]+)?$/);
    if (!match) return null;
    return {
        prefix: match[1],
        num: Number(match[2]),
        pad: match[2].length
    };
};

const hasSequentialFilenames = (files: any[]) => {
    const tokens = files.map((file) => extractSequenceToken(file.filename || file.r2_key || ''));
    if (tokens.some((token) => !token || Number.isNaN(token.num))) return false;
    const prefix = tokens[0]!.prefix;
    if (!tokens.every((token) => token!.prefix === prefix)) return false;
    const numbers = tokens.map((token) => token!.num).sort((a, b) => a - b);
    for (let index = 1; index < numbers.length; index += 1) {
        if (numbers[index] - numbers[index - 1] !== 1) return false;
    }
    return true;
};

const computeHdrConfidence = (files: any[]) => {
    if (files.length < 2) return 0;
    const hasExposureData = files.some((file) => exposureValue(file) !== null);
    const timeScore = scoreTime(files);
    const evSpan = evRange(files);
    const evRangeScore = evSpan >= 0.6 ? 0.2 : 0;
    const score = timeScore + scoreExposureSteps(files) + scoreParams(files) + scoreCamera(files) + evRangeScore;
    const preferredSize = files.length === 3 || files.length === 5 || files.length === 7;
    const fallback = preferredSize && hasExposureData && (timeScore >= 0.3 || hasSequentialFilenames(files) || evSpan >= 0.6) ? 0.7 : 0;
    return Math.max(0, Math.min(1, Math.max(score, fallback)));
};

const orderGroupFiles = (files: any[]) => {
    const withEv = files.some((file) => typeof file.ev === 'number');
    if (withEv) {
        return [...files].sort((a, b) => (a.ev ?? 0) - (b.ev ?? 0));
    }
    const withExposure = files.some((file) => typeof file.exposure_time === 'number');
    if (withExposure) {
        return [...files].sort((a, b) => (a.exposure_time ?? 0) - (b.exposure_time ?? 0));
    }
    const withTime = files.some((file) => file.exif_time);
    if (withTime) {
        return [...files].sort((a, b) => {
            if (a.exif_time && b.exif_time) {
                return new Date(a.exif_time).getTime() - new Date(b.exif_time).getTime();
            }
            if (!a.exif_time && b.exif_time) return 1;
            if (a.exif_time && !b.exif_time) return -1;
            return (a.filename || '').localeCompare(b.filename || '');
        });
    }
    return [...files].sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
};

const sortBySequence = (files: any[]) => {
    const withTokens = files.map((file: any) => ({
        file,
        token: extractSequenceToken(file.filename || file.r2_key || '')
    }));
    if (withTokens.some((item) => !item.token || Number.isNaN(item.token.num))) {
        return [...files];
    }
    return withTokens
        .sort((a, b) => (a.token!.num - b.token!.num))
        .map((item) => item.file);
};

const pickOutputLead = (files: any[]) => {
    if (!files.length) return null;
    const withTime = files.filter((file) => file.exif_time);
    if (withTime.length > 0) {
        return [...files].sort((a, b) => {
            if (a.exif_time && b.exif_time) {
                return new Date(a.exif_time).getTime() - new Date(b.exif_time).getTime();
            }
            if (a.exif_time) return -1;
            if (b.exif_time) return 1;
            return 0;
        })[0];
    }
    const sequential = sortBySequence(files);
    return sequential[0] || files[0];
};

const sameCaptureSetup = (a: any, b: any) => {
    if (a.camera_make && b.camera_make && a.camera_make !== b.camera_make) return false;
    if (a.camera_model && b.camera_model && a.camera_model !== b.camera_model) return false;
    if (typeof a.fnumber === 'number' && typeof b.fnumber === 'number') {
        if (Math.abs(a.fnumber - b.fnumber) > 0.2) return false;
    }
    if (typeof a.focal_length === 'number' && typeof b.focal_length === 'number') {
        if (Math.abs(a.focal_length - b.focal_length) > 2) return false;
    }
    return true;
};

const getExposureSeconds = (file: any) => {
    if (typeof file?.exposure_time !== 'number') return null;
    if (!Number.isFinite(file.exposure_time) || file.exposure_time <= 0) return null;
    return file.exposure_time;
};

const computeAllowedGapMs = (a: any, b: any, baseMs: number) => {
    const expA = getExposureSeconds(a) ?? 0;
    const expB = getExposureSeconds(b) ?? 0;
    const maxExp = Math.max(expA, expB);
    const dynamicMs = 1200 + (maxExp * 2500);
    return Math.max(baseMs, dynamicMs);
};

const splitExposureCluster = (cluster: any[], thresholdMs: number) => {
    if (cluster.length <= 1) return [cluster];
    if (cluster.length <= 7) return [cluster];
    const ordered = [...cluster].sort((a, b) => {
        if (a.exif_time && b.exif_time) {
            return new Date(a.exif_time).getTime() - new Date(b.exif_time).getTime();
        }
        if (a.exif_time) return -1;
        if (b.exif_time) return 1;
        return (a.filename || '').localeCompare(b.filename || '');
    });

    const groups: any[][] = [];
    let current: any[] = [];
    let direction = 0;
    let startExp: number | null = null;
    let minExp: number | null = null;
    let maxExp: number | null = null;

    const pushCurrent = () => {
        if (current.length > 0) groups.push(current);
        current = [];
        direction = 0;
        startExp = null;
        minExp = null;
        maxExp = null;
    };

    const updateRange = (value: number | null) => {
        if (value === null) return;
        if (minExp === null || value < minExp) minExp = value;
        if (maxExp === null || value > maxExp) maxExp = value;
    };

    for (const file of ordered) {
        if (current.length === 0) {
            current.push(file);
            const exp = exposureValue(file);
            startExp = exp;
            updateRange(exp);
            continue;
        }

        const last = current[current.length - 1];
        if (last.exif_time && file.exif_time) {
            const deltaMs = Math.abs(new Date(file.exif_time).getTime() - new Date(last.exif_time).getTime());
            const allowedGap = computeAllowedGapMs(last, file, thresholdMs);
            if (deltaMs > allowedGap || !sameCaptureSetup(last, file)) {
                pushCurrent();
                current.push(file);
                const exp = exposureValue(file);
                startExp = exp;
                updateRange(exp);
                continue;
            }
        }

        if (current.length >= 7) {
            pushCurrent();
            current.push(file);
            const exp = exposureValue(file);
            startExp = exp;
            updateRange(exp);
            continue;
        }

        const exp = exposureValue(file);
        const lastExp = exposureValue(last);
        if (exp !== null && lastExp !== null) {
            const deltaExp = exp - lastExp;
            if (direction === 0 && Math.abs(deltaExp) >= 0.4) {
                direction = deltaExp > 0 ? 1 : -1;
            }

            const range = (minExp !== null && maxExp !== null) ? (maxExp - minExp) : 0;
            const signFlip = direction !== 0 && ((direction > 0 && deltaExp < -0.6) || (direction < 0 && deltaExp > 0.6));
            const backToStart = startExp !== null && Math.abs(exp - startExp) <= 0.4;

            if (current.length >= 2 && signFlip && (backToStart || range >= 0.6)) {
                pushCurrent();
                current.push(file);
                startExp = exp;
                updateRange(exp);
                continue;
            }
        }

        current.push(file);
        updateRange(exp);
    }

    if (current.length > 0) groups.push(current);
    return groups;
};

const buildTimeGroups = (files: any[], thresholdMs: number) => {
    const groups: any[][] = [];
    let current: any[] = [];
    for (const file of files) {
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
        const allowedGap = computeAllowedGapMs(last, file, thresholdMs);
        if (delta <= allowedGap && sameCaptureSetup(last, file)) {
            current.push(file);
        } else {
            groups.push(current);
            current = [file];
        }
    }
    if (current.length > 0) groups.push(current);
    return groups;
};

const buildSequenceGroups = (files: any[]) => {
    if (!files.length) return [];
    const ordered = sortBySequence(files);
    const groups: any[][] = [];
    let current: any[] = [];
    let lastToken: ReturnType<typeof extractSequenceToken> | null = null;

    for (const file of ordered) {
        const token = extractSequenceToken(file.filename || file.r2_key || '');
        if (!token || Number.isNaN(token.num)) {
            if (current.length > 0) groups.push(current);
            current = [];
            lastToken = null;
            groups.push([file]);
            continue;
        }
        if (!lastToken || token.prefix !== lastToken.prefix || token.num !== lastToken.num + 1) {
            if (current.length > 0) groups.push(current);
            current = [file];
        } else {
            current.push(file);
        }
        lastToken = token;
    }
    if (current.length > 0) groups.push(current);
    return groups;
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

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files required' });
  }
  if (MAX_UPLOAD_FILES > 0 && files.length > MAX_UPLOAD_FILES) {
    return res.status(413).json({ error: `Too many files (max ${MAX_UPLOAD_FILES})` });
  }

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

// 7.1 删除任务（同步清理 DB + R2）
router.delete('/jobs/:jobId', authenticate, async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { jobId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { data: job, error: jobError } = await (supabaseAdmin
            .from('jobs') as any)
            .select('id, user_id, status, reserved_units, workflow_id')
            .eq('id', jobId)
            .eq('user_id', userId)
            .single();

        if (jobError || !job) return res.status(404).json({ error: 'Job not found' });

        const busyStatuses = new Set([
            'analyzing',
            'reserved',
            'preprocessing',
            'hdr_processing',
            'workflow_running',
            'ai_processing',
            'postprocess',
            'packaging',
            'zipping',
            'processing',
            'queued'
        ]);

        let reservedUnits = job.reserved_units || 0;
        if (busyStatuses.has(job.status)) {
            if (reservedUnits > 0) {
                const releaseKey = `release:${jobId}:cancel_for_delete`;
                const { error: releaseError } = await (supabaseAdmin as any).rpc('credit_release', {
                    p_user_id: userId,
                    p_job_id: jobId,
                    p_units: reservedUnits,
                    p_idempotency_key: releaseKey,
                    p_note: 'Release credits on delete'
                });
                if (releaseError) {
                    throw releaseError;
                }
                reservedUnits = 0;
            }
            await (supabaseAdmin.from('jobs') as any)
                .update({ status: 'canceled', error_message: 'Canceled by delete', reserved_units: 0 })
                .eq('id', jobId)
                .eq('user_id', userId);
            try {
                await jobQueue.remove(`pipeline:${jobId}`);
            } catch (error) {
                console.warn('Failed to remove queued job:', (error as Error).message);
            }
        }

        if (reservedUnits > 0) {
            const releaseKey = `release:${jobId}:delete`;
            const { error: releaseError } = await (supabaseAdmin as any).rpc('credit_release', {
                p_user_id: userId,
                p_job_id: jobId,
                p_units: reservedUnits,
                p_idempotency_key: releaseKey,
                p_note: 'Release credits on delete'
            });
            if (releaseError) {
                throw releaseError;
            }
        }

        const rawPrefix = `u/${userId}/jobs/${jobId}/raw/`;
        const legacyPrefix = `u/${userId}/jobs/${jobId}/`;
        const deleteTasks = [
            deletePrefix(RAW_BUCKET, rawPrefix),
            deletePrefix(HDR_BUCKET, `jobs/${jobId}/`),
            deletePrefix(OUTPUT_BUCKET, `jobs/${jobId}/`)
        ];
        if (!job.workflow_id && BUCKET_NAME && BUCKET_NAME !== RAW_BUCKET && BUCKET_NAME !== HDR_BUCKET && BUCKET_NAME !== OUTPUT_BUCKET) {
            deleteTasks.push(deletePrefix(BUCKET_NAME, legacyPrefix));
        }
        const deleteResults = await Promise.allSettled(deleteTasks);
        const deleteErrors = deleteResults
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason?.message || String(result.reason));
        if (deleteErrors.length) {
            console.warn('R2 delete failed for job', jobId, deleteErrors);
        }

        const { error: filesError } = await (supabaseAdmin.from('job_files') as any).delete().eq('job_id', jobId);
        const { error: groupsError } = await (supabaseAdmin.from('job_groups') as any).delete().eq('job_id', jobId);
        const { error: assetsError } = await (supabaseAdmin.from('job_assets') as any).delete().eq('job_id', jobId);
        const { error: jobsError } = await (supabaseAdmin.from('jobs') as any).delete().eq('id', jobId).eq('user_id', userId);
        if (filesError || groupsError || assetsError || jobsError) {
            throw new Error(filesError?.message || groupsError?.message || assetsError?.message || jobsError?.message || 'Delete failed');
        }

        res.json({ deleted: true });
    } catch (error) {
        console.error('Delete job failed:', { jobId, userId, error });
        const detail = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: 'Delete failed', detail });
    }
});

// 8. 获取个人资料 (含积分)
router.get('/profile', authenticate, async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await (supabaseAdmin.from('profiles') as any).select('*').eq('id', userId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    if (!data) {
        let trialPoints = 10;
        try {
            trialPoints = await getFreeTrialPoints();
        } catch (settingsError) {
            console.warn('Failed to load free trial points, using default.', settingsError);
        }
        const fallbackProfile = {
            id: userId,
            email: req.user?.email || null,
            points: trialPoints,
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
    const { files }: { files: { name: string; type: string; size?: number }[] } = req.body || {};
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files required' });
    if (MAX_UPLOAD_FILES > 0 && files.length > MAX_UPLOAD_FILES) return res.status(413).json({ error: `Too many files (max ${MAX_UPLOAD_FILES})` });

    const sizes = files.map((file) => file.size).filter((size) => typeof size === 'number');
    if (sizes.length !== files.length) {
        return res.status(400).json({ error: 'file size is required' });
    }

    const totalBytes = sizes.reduce((sum, value) => sum + value, 0);
    if (MAX_TOTAL_BYTES > 0 && totalBytes > MAX_TOTAL_BYTES) {
        return res.status(413).json({ error: `Total upload too large (max ${MAX_TOTAL_BYTES} bytes)` });
    }
    if (MAX_FILE_BYTES > 0) {
        const oversized = files.find((file) => typeof file.size === 'number' && file.size > MAX_FILE_BYTES);
        if (oversized) {
            return res.status(413).json({ error: `File too large: ${oversized.name}` });
        }
    }

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

    const keyPrefix = `u/${userId}/jobs/${jobId}/raw/`;
    const rows = files.map((file: any) => {
        const filename = sanitizeFilename(file.filename || file.name, 'image');
        const r2Key = file.r2_key || file.r2Key || file.key;
        if (!r2Key || typeof r2Key !== 'string') return null;
        if (!isSafeKey(r2Key, keyPrefix)) return null;
        return {
            job_id: jobId,
            r2_bucket: RAW_BUCKET,
            r2_key: r2Key,
            filename,
            input_kind: detectInputKind(filename, r2Key),
            exif_time: file.exif_time || null,
            size: file.size || null,
            camera_make: file.camera_make || null,
            camera_model: file.camera_model || null
        };
    }).filter((row: any) => row && row.r2_key);

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
        .select('id, r2_bucket, r2_key, filename, input_kind, exif_time, camera_make, camera_model, size, exposure_time, fnumber, iso, ev, focal_length')
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

    const needsExif = fileList.filter((file: any) => file.input_kind === 'raw' && (!file.exif_time || file.ev === null || file.exposure_time === null || file.fnumber === null || file.iso === null || file.focal_length === null));
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
                if (meta.focal_length !== null) updates.focal_length = meta.focal_length;

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

    const hasMissingExif = rawFiles.some((file: any) => !file.exif_time);
    const hasSequentialAll = rawFiles.length >= 3 && hasSequentialFilenames(rawFiles);

    const sortedRaw = [...rawFiles].sort((a: any, b: any) => {
        if (a.exif_time && b.exif_time) {
            return new Date(a.exif_time).getTime() - new Date(b.exif_time).getTime();
        }
        if (!a.exif_time && b.exif_time) return -1;
        if (a.exif_time && !b.exif_time) return 1;
        return (a.filename || '').localeCompare(b.filename || '');
    });

    const thresholdMs = Number.parseInt(process.env.HDR_GROUP_TIME_MS || '2000', 10);
    let timeGroups: any[][] = hasMissingExif && hasSequentialAll
        ? [sortBySequence(sortedRaw)]
        : buildTimeGroups(sortedRaw.filter((file: any) => file.exif_time), thresholdMs)
            .concat(buildSequenceGroups(sortedRaw.filter((file: any) => !file.exif_time)));

    if (hasSequentialAll && timeGroups.length > 0 && !timeGroups.some((group) => group.length >= 3)) {
        timeGroups = buildSequenceGroups(sortedRaw);
    }

    const groups: { files: any[]; group_type: string; hdr_confidence: number | null; output_filename: string }[] = [];

    for (const cluster of timeGroups) {
        const segments = splitExposureCluster(cluster, thresholdMs);
        for (const segment of segments) {
            if (segment.length === 0) continue;
            const hasExposureData = segment.some((file: any) => typeof file.ev === 'number' || typeof file.exposure_time === 'number');

            if (!hasExposureData && segment.length >= 3) {
                const { sizes } = exposurePlan(segment.length);
                let offset = 0;
                for (const size of sizes) {
                    const subset = orderGroupFiles(segment.slice(offset, offset + size));
                    offset += size;
                    const confidence = computeHdrConfidence(subset);
                    if (confidence >= 0.7) {
                        const lead = pickOutputLead(subset) || subset[0];
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

                const remaining = segment.length - offset;
                for (let i = 0; i < remaining; i += 1) {
                    const file = segment[offset + i];
                    groups.push({
                        files: [file],
                        group_type: 'raw',
                        hdr_confidence: null,
                        output_filename: normalizeOutputFilename(file.filename, file.r2_key.split('/').pop() || 'image')
                    });
                }
                continue;
            }

            const orderedSegment = orderGroupFiles(segment);
            const confidence = computeHdrConfidence(orderedSegment);
            if (orderedSegment.length >= 2 && confidence >= 0.7) {
                const lead = pickOutputLead(orderedSegment) || orderedSegment[0];
                groups.push({
                    files: orderedSegment,
                    group_type: 'hdr',
                    hdr_confidence: confidence,
                    output_filename: normalizeOutputFilename(lead.filename, lead.r2_key.split('/').pop() || 'hdr')
                });
            } else {
                for (const file of orderedSegment) {
                    groups.push({
                        files: [file],
                        group_type: 'raw',
                        hdr_confidence: confidence,
                        output_filename: normalizeOutputFilename(file.filename, file.r2_key.split('/').pop() || 'image')
                    });
                }
            }
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

    const groupRows = groups.map((group, index) => {
        const repIndex = Math.floor((group.files.length - 1) / 2);
        const representative = group.files[repIndex];
        return {
            id: uuidv4(),
            job_id: jobId,
            group_index: index + 1,
            raw_count: group.files.filter(file => file.input_kind === 'raw').length,
            status: 'queued',
            group_type: group.group_type,
            hdr_confidence: group.hdr_confidence,
            output_filename: group.output_filename,
            representative_file_id: representative?.id ?? null
        };
    });

    const { error: groupError } = await (supabaseAdmin.from('job_groups') as any)
        .insert(groupRows);
    if (groupError) return res.status(500).json({ error: groupError.message });

    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const groupId = groupRows[index].id;
        const orderUpdates = group.files.map((item: any, orderIndex: number) => ({
            id: item.id,
            group_id: groupId,
            group_order: orderIndex + 1
        }));
        await runWithConcurrency(orderUpdates, 4, async (update) => {
            await (supabaseAdmin.from('job_files') as any)
                .update({ group_id: update.group_id, group_order: update.group_order })
                .eq('id', update.id);
        });
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

// New pipeline: generate previews (RAW embedded JPGs)
router.post('/jobs/:jobId/previews', authenticate, async (req: AuthRequest, res: Response) => {
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

    try {
        await jobQueue.add('preview-job', { jobId }, {
            jobId: `preview:${jobId}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true
        });
    } catch (error) {
        console.warn('Failed to enqueue preview job:', (error as Error).message);
        return res.status(503).json({ error: 'Preview queue unavailable' });
    }

    res.json({ queued: true });
});

// New pipeline: update group representative frame
router.post('/jobs/:jobId/groups/:groupId/representative', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId, groupId } = req.params;
    const userId = req.user?.id;
    const { fileId } = req.body || {};

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });

    const { data: group } = await (supabaseAdmin
        .from('job_groups') as any)
        .select('id, job_id')
        .eq('id', groupId)
        .eq('job_id', jobId)
        .single();
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { data: file } = await (supabaseAdmin
        .from('job_files') as any)
        .select('id, job_id, group_id')
        .eq('id', fileId)
        .eq('job_id', jobId)
        .eq('group_id', groupId)
        .single();
    if (!file) return res.status(404).json({ error: 'File not found in group' });

    const { error: updateError } = await (supabaseAdmin
        .from('job_groups') as any)
        .update({ representative_file_id: fileId })
        .eq('id', groupId)
        .eq('job_id', jobId);
    if (updateError) return res.status(500).json({ error: updateError.message });

    res.json({ representative_file_id: fileId });
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
        const releaseKey = `release:${jobId}:enqueue_failed`;
        await (supabaseAdmin as any).rpc('credit_release', {
            p_user_id: userId,
            p_job_id: jobId,
            p_units: creditsToReserve,
            p_idempotency_key: releaseKey,
            p_note: 'Release credits after queue failure'
        });
        await (supabaseAdmin.from('jobs') as any)
            .update({ status: 'input_resolved', reserved_units: 0 })
            .eq('id', jobId)
            .eq('user_id', userId);
        return res.status(503).json({ error: 'Queue unavailable, please retry' });
    }

    res.json({ reserved_units: job.estimated_units, credits_reserved: creditsToReserve, balance });
});

// New pipeline: cancel job
router.post('/jobs/:jobId/cancel', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: job, error } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, status, reserved_units')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();

    if (error || !job) return res.status(404).json({ error: 'Job not found' });

    const terminalStatuses = new Set(['completed', 'failed', 'canceled', 'partial']);
    if (terminalStatuses.has(job.status)) {
        return res.json({ canceled: false, status: job.status });
    }

    await (supabaseAdmin.from('jobs') as any)
        .update({ status: 'canceled', error_message: 'Canceled by user', reserved_units: 0 })
        .eq('id', jobId)
        .eq('user_id', userId);

    await (supabaseAdmin.from('job_groups') as any)
        .update({ status: 'failed', last_error: 'Canceled by user' })
        .eq('job_id', jobId)
        .neq('status', 'ai_ok');

    if (job.reserved_units && job.reserved_units > 0) {
        const releaseKey = `release:${jobId}:cancel`;
        await (supabaseAdmin as any).rpc('credit_release', {
            p_user_id: userId,
            p_job_id: jobId,
            p_units: job.reserved_units,
            p_idempotency_key: releaseKey,
            p_note: 'Release credits on cancel'
        });
    }

    res.json({ canceled: true, status: 'canceled' });
});

// New pipeline: retry missing/failed groups
router.post('/jobs/:jobId/retry-missing', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: job, error: jobError } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, workflow_id, workflow_version_id, status, reserved_units')
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

    const failedGroups = (groups || []).filter((group: any) => group.status === 'failed');
    const retryable = failedGroups.filter((group: any) => (group.attempts || 0) < maxAttempts);

    if (retryable.length === 0 && failedGroups.length === 0) {
        return res.json({ retried: 0, message: 'No failed groups to retry' });
    }

    const retryIds = (retryable.length > 0 ? retryable : failedGroups).map((group: any) => group.id);
    const forced = retryable.length === 0 && failedGroups.length > 0;
    const retryCount = retryIds.length;

    let creditsReserved = 0;
    let balance = null;
    if (!job.reserved_units || job.reserved_units <= 0) {
        const { data: workflow, error: workflowError } = await (supabaseAdmin
            .from('workflows') as any)
            .select('credit_per_unit')
            .eq('id', job.workflow_id)
            .single();
        if (workflowError || !workflow) {
            return res.status(400).json({ error: 'Workflow not found' });
        }

        const creditsToReserve = retryCount * (workflow.credit_per_unit || 1);
        const idempotencyKey = `reserve:retry:${jobId}:${Date.now()}`;
        const reserveResult = await (supabaseAdmin as any)
            .rpc('credit_reserve', {
                p_user_id: userId,
                p_job_id: jobId,
                p_units: creditsToReserve,
                p_idempotency_key: idempotencyKey,
                p_note: 'Reserve credits for retry'
            });
        if (reserveResult.error) {
            const message = reserveResult.error.message || 'Failed to reserve credits';
            const status = message.includes('insufficient credits') ? 402 : 500;
            return res.status(status).json({ error: message });
        }
        creditsReserved = creditsToReserve;
        balance = reserveResult.data;
    }

    const { error: retryError } = await (supabaseAdmin.from('job_groups') as any)
        .update({
            status: 'queued',
            attempts: 0,
            hdr_bucket: null,
            hdr_key: null,
            output_bucket: null,
            output_key: null,
            last_error: null
        })
        .in('id', retryIds);
    if (retryError) return res.status(500).json({ error: retryError.message });

    await (supabaseAdmin.from('jobs') as any)
        .update({ status: 'reserved', progress: 0, error_message: null, reserved_units: retryCount })
        .eq('id', jobId)
        .eq('user_id', userId);

    await jobQueue.add('pipeline-job', { jobId }, {
        jobId: `pipeline:${jobId}:retry:${Date.now()}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true
    });

    res.json({ retried: retryIds.length, forced, credits_reserved: creditsReserved, balance });
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

const buildPipelineStatusPayload = async (jobId: string, userId: string) => {
    const { data: job, error } = await (supabaseAdmin
        .from('jobs') as any)
        .select('id, status, estimated_units, reserved_units, settled_units, progress, zip_key, created_at, project_name, workflow_id, workflow_version_id')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();
    if (error || !job) return null;

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
        .select('id, group_index, status, hdr_bucket, hdr_key, output_bucket, output_key, output_filename, last_error, representative_file_id, group_type')
        .eq('job_id', jobId)
        .order('group_index', { ascending: true });

    const { data: fileRows } = await (supabaseAdmin.from('job_files') as any)
        .select('id, group_id, r2_bucket, r2_key, filename, input_kind, preview_bucket, preview_key, preview_ready, group_order')
        .eq('job_id', jobId);

    const filesByGroup = new Map<string, any[]>();
    (fileRows || []).forEach((file: any) => {
        if (!file.group_id) return;
        const list = filesByGroup.get(file.group_id) || [];
        list.push(file);
        filesByGroup.set(file.group_id, list);
    });

    const resolveInputKind = (file: any) => file?.input_kind || detectInputKind(file?.filename, file?.r2_key);
    const isPreviewReady = (file: any) => {
        const kind = resolveInputKind(file);
        if (kind && kind !== 'raw') return true;
        return Boolean(file?.preview_key || file?.preview_ready);
    };

    const previewTotal = (fileRows || []).length;
    const previewReady = (fileRows || []).filter((file: any) => isPreviewReady(file)).length;

    const buildPreviewUrl = async (file: any) => {
        if (!file) return null;
        if (file.preview_key) {
            return getPresignedGetUrl(file.preview_bucket || HDR_BUCKET, file.preview_key, 900);
        }
        const kind = resolveInputKind(file);
        if (kind && kind !== 'raw') {
            return getPresignedGetUrl(file.r2_bucket || RAW_BUCKET, file.r2_key, 900);
        }
        return null;
    };

    const items = await Promise.all((groupRows || []).map(async (group: any) => {
        const hdrUrl = group.hdr_key
            ? await getPresignedGetUrl(group.hdr_bucket || HDR_BUCKET, group.hdr_key, 900)
            : null;
        const outputUrl = group.output_key
            ? await getPresignedGetUrl(group.output_bucket || OUTPUT_BUCKET, group.output_key, 900)
            : null;
        const framesRaw = (filesByGroup.get(group.id) || []).sort((a, b) => {
            if (typeof a.group_order === 'number' && typeof b.group_order === 'number') {
                return a.group_order - b.group_order;
            }
            return (a.filename || '').localeCompare(b.filename || '');
        });
        const groupSize = framesRaw.length || 1;
        const representativeIndex = Math.max(0, framesRaw.findIndex((file: any) => file.id === group.representative_file_id));
        const repIndex = representativeIndex >= 0 ? representativeIndex : Math.floor((groupSize - 1) / 2);
        const frames = await Promise.all(framesRaw.map(async (file: any, index: number) => ({
            id: file.id,
            filename: file.filename || path.basename(file.r2_key),
            order: index + 1,
            preview_url: await buildPreviewUrl(file),
            input_kind: resolveInputKind(file),
            preview_ready: isPreviewReady(file)
        })));
        const representativeFrame = frames[repIndex] || frames[0] || null;
        const previewUrl = representativeFrame?.preview_url || null;

        return {
            id: group.id,
            group_index: group.group_index,
            status: group.status,
            group_type: group.group_type || null,
            output_filename: group.output_filename,
            hdr_url: hdrUrl,
            output_url: outputUrl,
            preview_url: previewUrl,
            group_size: groupSize,
            representative_index: representativeFrame?.order || 1,
            frames,
            last_error: group.last_error || null
        };
    }));

    const progress = typeof job.progress === 'number'
        ? job.progress
        : summary.total > 0
            ? Math.round(((summary.success + summary.failed) / summary.total) * 100)
            : 0;

    return { job, groups: summary, items, progress, previews: { total: previewTotal, ready: previewReady } };
};

// New pipeline: job status
router.get('/jobs/:jobId/status', authenticate, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const payload = await buildPipelineStatusPayload(jobId, userId);
    if (!payload) return res.status(404).json({ error: 'Job not found' });

    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
});

router.get('/jobs/:jobId/stream', authenticateSse, async (req: AuthRequest, res: Response) => {
    const { jobId } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('retry: 3000\n\n');
    res.flushHeaders?.();

    let closed = false;
    let pending = false;
    const terminalStatuses = new Set(['completed', 'partial', 'failed', 'canceled']);
    let lastPreviewReady = 0;
    let lastPreviewTotal = 0;
    const lastGroupState = new Map<string, { previewReady: number; hdrReady: boolean; aiReady: boolean }>();

    const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const countPreviewReady = (item: any) => {
        const frames = Array.isArray(item?.frames) ? item.frames : [];
        const total = frames.length || 1;
        const ready = frames.filter((frame: any) => frame?.preview_ready || frame?.preview_url).length;
        return { ready, total };
    };

    const isHdrReady = (item: any) => Boolean(item?.hdr_url) || ['hdr_ok', 'ai_ok'].includes(item?.status);
    const isAiReady = (item: any) => Boolean(item?.output_url) || item?.status === 'ai_ok';

    const emitItemEvents = (payload: any) => {
        const previews = payload?.previews;
        if (previews && (previews.ready !== lastPreviewReady || previews.total !== lastPreviewTotal)) {
            lastPreviewReady = previews.ready;
            lastPreviewTotal = previews.total;
            sendEvent('preview-ready', { previews });
        }

        const items = Array.isArray(payload?.items) ? payload.items : [];
        items.forEach((item: any) => {
            if (!item?.id) return;
            const { ready, total } = countPreviewReady(item);
            const hdrReady = isHdrReady(item);
            const aiReady = isAiReady(item);
            const prev = lastGroupState.get(item.id);

            if (!prev || ready !== prev.previewReady) {
                sendEvent('preview-ready', { group: item, ready, total, previews });
            }
            if (!prev?.hdrReady && hdrReady) {
                sendEvent('hdr-ready', { group: item });
            }
            if (!prev?.aiReady && aiReady) {
                sendEvent('ai-ready', { group: item });
            }

            lastGroupState.set(item.id, { previewReady: ready, hdrReady, aiReady });
        });
    };

    const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(pingTimer);
        res.end();
    };

    const pushStatus = async () => {
        if (closed || pending) return;
        pending = true;
        try {
            const payload = await buildPipelineStatusPayload(jobId, userId);
            if (!payload) {
                sendEvent('error', { error: 'Job not found' });
                closeStream();
                return;
            }
            emitItemEvents(payload);
            sendEvent('status', payload);
            if (terminalStatuses.has(payload.job.status)) {
                sendEvent('done', { status: payload.job.status });
                closeStream();
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Stream error';
            sendEvent('error', { error: message });
            closeStream();
        } finally {
            pending = false;
        }
    };

    const pollTimer = setInterval(() => {
        void pushStatus();
    }, Math.max(SSE_POLL_MS, 1000));

    const pingTimer = setInterval(() => {
        if (closed) return;
        res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
        closeStream();
    });

    await pushStatus();
});

export default router;
