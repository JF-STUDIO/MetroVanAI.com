import './config.js';
import { Worker, Job, QueueEvents } from 'bullmq';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import archiver from 'archiver';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { supabaseAdmin } from './services/supabase.js';
import {
  r2Client,
  RAW_BUCKET,
  HDR_BUCKET,
  OUTPUT_BUCKET,
  getPresignedGetUrl,
  deleteObject,
  headObject
} from './services/r2.js';
import { createRedis } from './services/redis.js';
import { createHdrForGroup, cleanupHdrTemp, convertToJpeg } from './services/hdr.js';
import { createRunningHubTask, pollRunningHub } from './services/runninghub.js';

const HDR_CONCURRENCY = Number.parseInt(process.env.HDR_CONCURRENCY || '2', 10);
const AI_CONCURRENCY = Number.parseInt(process.env.AI_CONCURRENCY || '1', 10);

const runWithConcurrency = async <T>(items: T[], limit: number, handler: (item: T) => Promise<void>) => {
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

const updateJobProgress = async (jobId: string) => {
  const { data: groups } = await (supabaseAdmin.from('job_groups') as any)
    .select('status')
    .eq('job_id', jobId);

  const total = groups?.length || 0;
  if (total === 0) return;

  const done = groups.filter((group: any) => group.status === 'ai_ok' || group.status === 'failed').length;
  const progress = Math.min(100, Math.floor((done / total) * 100));

  await (supabaseAdmin.from('jobs') as any)
    .update({ progress })
    .eq('id', jobId);
};

const fetchWorkflowContext = async (workflowId: string, workflowVersionId: string) => {
  const { data: version, error: versionError } = await (supabaseAdmin
    .from('workflow_versions') as any)
    .select('id, workflow_id, workflow_remote_id, input_schema, output_schema, runtime_config')
    .eq('id', workflowVersionId)
    .single();

  if (versionError || !version) throw new Error('Workflow version not found');

  const { data: workflow, error: workflowError } = await (supabaseAdmin
    .from('workflows') as any)
    .select('id, slug, provider_id')
    .eq('id', workflowId)
    .single();

  if (workflowError || !workflow) throw new Error('Workflow not found');

  const { data: provider, error: providerError } = await (supabaseAdmin
    .from('workflow_providers') as any)
    .select('id, name, base_url, create_path, status_path, status_mode')
    .eq('id', workflow.provider_id)
    .single();

  if (providerError || !provider) throw new Error('Workflow provider not found');

  const runtimeConfig = (version.runtime_config || {}) as Record<string, unknown>;
  const inputSchema = (version.input_schema || {}) as Record<string, unknown>;

  let inputKey = (runtimeConfig.input_node_key as string | undefined) || (inputSchema.input_node_key as string | undefined);
  if (!inputKey) {
    const { data: tool } = await (supabaseAdmin.from('photo_tools') as any)
      .select('input_node_key')
      .eq('workflow_id', workflow.slug)
      .single();
    inputKey = tool?.input_node_key || 'input_image';
  }

  return {
    provider,
    workflow,
    version,
    inputKey: inputKey || 'input_image',
    runtimeConfig
  };
};

const uploadFileToR2 = async (bucket: string, key: string, filePath: string, contentType: string) => {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType
    })
  );
};

const downloadOutputToJpg = async (outputUrl: string, bucket: string, key: string) => {
  const response = await axios.get(outputUrl, { responseType: 'arraybuffer' });
  const contentType = response.headers['content-type'] || '';
  const extension = (() => {
    try {
      return path.extname(new URL(outputUrl).pathname).toLowerCase();
    } catch {
      return '';
    }
  })();

  const isJpeg = contentType.includes('jpeg') || contentType.includes('jpg') || ['.jpg', '.jpeg'].includes(extension);
  if (isJpeg) {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: response.data,
        ContentType: 'image/jpeg'
      })
    );
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvai-output-'));
  try {
    const sourcePath = path.join(tempDir, `source${extension || '.bin'}`);
    const jpgPath = path.join(tempDir, 'output.jpg');
    await fs.writeFile(sourcePath, response.data);
    await convertToJpeg(sourcePath, jpgPath);
    await uploadFileToR2(bucket, key, jpgPath, 'image/jpeg');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const downloadR2ObjectToFile = async (bucket: string, key: string, filePath: string) => {
  const { Body } = await r2Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body || typeof (Body as NodeJS.ReadableStream).pipe !== 'function') {
    throw new Error('R2 object body is not a readable stream');
  }
  await pipeline(Body as NodeJS.ReadableStream, createWriteStream(filePath));
};

const createZipArchive = async (files: { path: string; name: string }[], zipPath: string) => {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', (err) => reject(err));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    for (const file of files) {
      archive.file(file.path, { name: file.name });
    }
    archive.finalize().catch(reject);
  });
};

const sanitizeZipName = (value: string | null | undefined) => {
  const base = (value || 'project').trim().replace(/\s+/g, '_');
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || 'project';
};

const dedupeNames = (names: string[]) => {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    return `${base}_${count + 1}${ext}`;
  });
};

const applyCreditAdjustments = async (
  job: { id: string; user_id: string; workflow_id: string; settled_units?: number | null; reserved_units?: number | null },
  totalGroups: number,
  successCount: number,
  finalFailureCount: number
) => {
  const { data: workflow } = await (supabaseAdmin.from('workflows') as any)
    .select('credit_per_unit')
    .eq('id', job.workflow_id)
    .single();

  const creditPerUnit = workflow?.credit_per_unit || 1;
  const prevSettled = job.settled_units || 0;
  const prevReserved = job.reserved_units ?? totalGroups;
  const releasedAlready = Math.max(totalGroups - prevReserved - prevSettled, 0);

  const settleDelta = Math.max(successCount - prevSettled, 0);
  const releaseDelta = Math.max(finalFailureCount - releasedAlready, 0);

  if (settleDelta > 0) {
    await (supabaseAdmin as any).rpc('credit_settle', {
      p_user_id: job.user_id,
      p_job_id: job.id,
      p_units: settleDelta * creditPerUnit,
      p_idempotency_key: `settle:${job.id}:${prevSettled}->${successCount}`,
      p_note: 'Settle credits for completed groups'
    });
  }

  if (releaseDelta > 0) {
    await (supabaseAdmin as any).rpc('credit_release', {
      p_user_id: job.user_id,
      p_job_id: job.id,
      p_units: releaseDelta * creditPerUnit,
      p_idempotency_key: `release:${job.id}:${releasedAlready}->${finalFailureCount}`,
      p_note: 'Release credits for failed groups'
    });
  }

  const remainingReserved = Math.max(totalGroups - successCount - finalFailureCount, 0);
  return { settled_units: successCount, reserved_units: remainingReserved };
};

const releaseCreditsForFailure = async (jobId: string, errorMessage: string) => {
  const { data: job } = await (supabaseAdmin
    .from('jobs') as any)
    .select('id, user_id, workflow_id, settled_units, reserved_units')
    .eq('id', jobId)
    .single();

  if (!job) return;

  const { data: groups } = await (supabaseAdmin.from('job_groups') as any)
    .select('status')
    .eq('job_id', jobId);

  const totalGroups = groups?.length || (job.reserved_units ?? 0) || 0;
  const successCount = groups ? groups.filter((group: any) => group.status === 'ai_ok').length : 0;
  const finalFailureCount = Math.max(totalGroups - successCount, 0);

  if (groups && groups.length > 0) {
    await (supabaseAdmin.from('job_groups') as any)
      .update({ status: 'failed', last_error: errorMessage })
      .eq('job_id', jobId)
      .neq('status', 'ai_ok');
  }

  if (totalGroups > 0) {
    const creditUpdate = await applyCreditAdjustments(job, totalGroups, successCount, finalFailureCount);
    await (supabaseAdmin.from('jobs') as any)
      .update({ ...creditUpdate })
      .eq('id', jobId);
  }
};

const isJobCanceled = async (jobId: string) => {
  const { data: job } = await (supabaseAdmin
    .from('jobs') as any)
    .select('status')
    .eq('id', jobId)
    .single();
  return job?.status === 'canceled';
};

const finalizePipelineJob = async (
  job: { id: string; user_id: string; workflow_id: string; project_name?: string | null; settled_units?: number | null; reserved_units?: number | null },
  runtimeConfig: Record<string, unknown>
) => {
  const { data: groups } = await (supabaseAdmin.from('job_groups') as any)
    .select('id, group_index, status, output_bucket, output_key, output_filename, attempts')
    .eq('job_id', job.id)
    .order('group_index', { ascending: true });

  const totalGroups = groups?.length || 0;
  if (!groups || totalGroups === 0) {
    await (supabaseAdmin.from('jobs') as any)
      .update({ status: 'failed', error_message: 'No job groups found' })
      .eq('id', job.id);
    return;
  }

  const maxAttempts = Number(runtimeConfig.max_attempts ?? 3);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvai-zip-'));
  const zipEntries: { path: string; name: string }[] = [];
  const successful: { output_key: string; output_filename: string }[] = [];

  try {
    for (const group of groups) {
      if (group.status !== 'ai_ok' || !group.output_key) {
        continue;
      }

      const bucket = group.output_bucket || OUTPUT_BUCKET;
      const exists = await headObject(bucket, group.output_key);
      if (!exists) {
        const attempts = (group.attempts || 0) + 1;
        await (supabaseAdmin.from('job_groups') as any)
          .update({
            status: 'failed',
            attempts,
            last_error: 'Output missing in R2'
          })
          .eq('id', group.id);
        continue;
      }

      const outputName = group.output_filename || path.basename(group.output_key);
      successful.push({ output_key: group.output_key, output_filename: outputName });
    }

    const { data: refreshedGroups } = await (supabaseAdmin.from('job_groups') as any)
      .select('status, attempts')
      .eq('job_id', job.id);

    const successCount = successful.length;
    const failedFinalCount = (refreshedGroups || []).filter((group: any) => (
      group.status === 'failed' && (group.attempts || 0) >= maxAttempts
    )).length;

    const creditUpdate = await applyCreditAdjustments(job, totalGroups, successCount, failedFinalCount);

    if (successCount === 0) {
      await (supabaseAdmin.from('jobs') as any)
        .update({
          status: 'failed',
          error_message: 'No successful outputs',
          ...creditUpdate
        })
        .eq('id', job.id);
      return;
    }

    if (successCount === 1) {
      const only = successful[0];
      const status = successCount === totalGroups ? 'completed' : 'partial';
      await (supabaseAdmin.from('jobs') as any)
        .update({
          status,
          output_file_key: only.output_key,
          output_file_name: only.output_filename,
          progress: 100,
          ...creditUpdate
        })
        .eq('id', job.id);
      return;
    }

    await (supabaseAdmin.from('jobs') as any)
      .update({ status: 'packaging' })
      .eq('id', job.id);

    const dedupedNames = dedupeNames(successful.map(item => item.output_filename));
    for (let index = 0; index < successful.length; index += 1) {
      const item = successful[index];
      const entryName = dedupedNames[index];
      const localPath = path.join(tempDir, entryName);
      await downloadR2ObjectToFile(OUTPUT_BUCKET, item.output_key, localPath);
      zipEntries.push({ path: localPath, name: entryName });
    }

    const zipPath = path.join(tempDir, 'outputs.zip');
    await createZipArchive(zipEntries, zipPath);

    const zipName = `${sanitizeZipName(job.project_name)}_processed.zip`;
    const zipKey = `jobs/${job.id}/${zipName}`;
    await uploadFileToR2(OUTPUT_BUCKET, zipKey, zipPath, 'application/zip');

    const status = successCount === totalGroups ? 'completed' : 'partial';
    await (supabaseAdmin.from('jobs') as any)
      .update({
        status,
        output_zip_key: zipKey,
        zip_key: zipKey,
        progress: 100,
        ...creditUpdate
      })
      .eq('id', job.id);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const processHdrGroup = async (jobId: string, group: any) => {
  const { data: files } = await (supabaseAdmin.from('job_files') as any)
    .select('id, r2_bucket, r2_key')
    .eq('job_id', jobId)
    .eq('group_id', group.id);

  if (!files || files.length === 0) {
    throw new Error('No files found for HDR group');
  }

  const sources = files.map((file: any) => ({
    bucket: file.r2_bucket || RAW_BUCKET,
    key: file.r2_key
  }));

  const outputName = `${group.id}.jpg`;
  const { outputPath, tempDir } = await createHdrForGroup(sources, outputName);
  const hdrKey = `jobs/${jobId}/${outputName}`;

  await uploadFileToR2(HDR_BUCKET, hdrKey, outputPath, 'image/jpeg');
  await cleanupHdrTemp(tempDir);

  const attempts = (group.attempts || 0) + 1;
  await (supabaseAdmin.from('job_groups') as any)
    .update({
      hdr_bucket: HDR_BUCKET,
      hdr_key: hdrKey,
      status: 'preprocess_ok',
      attempts,
      last_error: null
    })
    .eq('id', group.id);
};

const processRunningHubGroup = async (
  jobId: string,
  group: any,
  context: {
    provider: any;
    version: any;
    inputKey: string;
    runtimeConfig: Record<string, unknown>;
  }
) => {
  if (!group.hdr_key) {
    throw new Error('HDR output missing for group');
  }

  const maxAttempts = Number(context.runtimeConfig.max_attempts ?? 3);
  const retryBase = Number(context.runtimeConfig.ai_retry_backoff_sec ?? 2);
  const retryCap = Number(context.runtimeConfig.ai_retry_backoff_cap ?? 30);
  let attempts = group.attempts || 0;
  let backoff = retryBase;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const inputUrl = await getPresignedGetUrl(HDR_BUCKET, group.hdr_key, 3600);
      const { taskId } = await createRunningHubTask(
        context.provider,
        context.version.workflow_remote_id,
        context.inputKey,
        inputUrl,
        context.runtimeConfig
      );

      const result = await pollRunningHub(context.provider, taskId, context.runtimeConfig);
      if (result.status !== 'SUCCESS') {
        throw new Error('RunningHub processing failed');
      }

      const outputUrl = result.outputUrls[0];
      if (!outputUrl) {
        throw new Error('RunningHub output URL missing');
      }

      const outputKey = `jobs/${jobId}/${group.id}.jpg`;
      await downloadOutputToJpg(outputUrl, OUTPUT_BUCKET, outputKey);
      await deleteObject(HDR_BUCKET, group.hdr_key);

      await (supabaseAdmin.from('job_groups') as any)
        .update({
          output_bucket: OUTPUT_BUCKET,
          output_key: outputKey,
          status: 'ai_ok',
          attempts,
          last_error: null
        })
        .eq('id', group.id);
      return;
    } catch (error) {
      const message = (error as Error).message;
      if (attempts >= maxAttempts) {
        await (supabaseAdmin.from('job_groups') as any)
          .update({ status: 'failed', attempts, last_error: message })
          .eq('id', group.id);
        throw error;
      }

      await (supabaseAdmin.from('job_groups') as any)
        .update({ attempts, last_error: message })
        .eq('id', group.id);
      await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
      backoff = Math.min(backoff * 2, retryCap);
    }
  }
};

const processPipelineJob = async (jobId: string) => {
  const { data: job, error: jobError } = await (supabaseAdmin
    .from('jobs') as any)
    .select('id, user_id, workflow_id, workflow_version_id, settled_units, reserved_units, project_name, status')
    .eq('id', jobId)
    .single();

  if (jobError || !job) throw new Error('Pipeline job not found');
  if (!job.workflow_id || !job.workflow_version_id) throw new Error('Pipeline job missing workflow metadata');
  if (job.status === 'canceled') return;

  const context = await fetchWorkflowContext(job.workflow_id, job.workflow_version_id);
  const hdrConcurrency = Number(context.runtimeConfig.hdr_concurrency ?? HDR_CONCURRENCY);
  const aiConcurrency = Number(context.runtimeConfig.ai_concurrency ?? AI_CONCURRENCY);

  if (await isJobCanceled(jobId)) return;
  await (supabaseAdmin.from('jobs') as any)
    .update({ status: 'preprocessing', error_message: null })
    .eq('id', jobId);

  const { data: hdrGroups } = await (supabaseAdmin.from('job_groups') as any)
    .select('id, status, attempts')
    .eq('job_id', jobId)
    .order('group_index', { ascending: true });

  if (!hdrGroups || hdrGroups.length === 0) {
    throw new Error('No job groups found');
  }

  const pendingHdr = ((hdrGroups || []) as any[]).filter((group: any) => group.status === 'queued');
  await runWithConcurrency(pendingHdr, hdrConcurrency, async (group) => {
    if (await isJobCanceled(jobId)) return;
    try {
      await processHdrGroup(jobId, group);
      await updateJobProgress(jobId);
    } catch (error) {
      const attempts = (group.attempts || 0) + 1;
      await (supabaseAdmin.from('job_groups') as any)
        .update({ status: 'failed', attempts, last_error: (error as Error).message })
        .eq('id', group.id);
    }
  });

  if (await isJobCanceled(jobId)) return;
  await (supabaseAdmin.from('jobs') as any)
    .update({ status: 'workflow_running' })
    .eq('id', jobId);

  const { data: aiGroups } = await (supabaseAdmin.from('job_groups') as any)
    .select('id, status, hdr_key, attempts')
    .eq('job_id', jobId)
    .order('group_index', { ascending: true });

  const pendingAi = ((aiGroups || []) as any[]).filter((group: any) => (
    group.status === 'preprocess_ok' || group.status === 'hdr_ok'
  ));
  await runWithConcurrency(pendingAi, aiConcurrency, async (group) => {
    if (await isJobCanceled(jobId)) return;
    try {
      await processRunningHubGroup(jobId, group, context);
      await updateJobProgress(jobId);
    } catch (error) {
      const attempts = (group.attempts || 0) + 1;
      await (supabaseAdmin.from('job_groups') as any)
        .update({ status: 'failed', attempts, last_error: (error as Error).message })
        .eq('id', group.id);
    }
  });

  if (await isJobCanceled(jobId)) return;
  await (supabaseAdmin.from('jobs') as any)
    .update({ status: 'postprocess' })
    .eq('id', jobId);

  await finalizePipelineJob(job, context.runtimeConfig);
};

const processLegacyJob = async (jobId: string) => {
  console.log(`Processing legacy job ${jobId}...`);

  // 1. 更新任务状态为处理中
  await (supabaseAdmin.from('jobs') as any).update({ status: 'processing' }).eq('id', jobId);

  // 2. 获取任务及其资产
  const { data: jobData, error: jobErr } = await (supabaseAdmin
    .from('jobs') as any)
    .select('*, job_assets(*)')
    .eq('id', jobId)
    .single();

  if (jobErr || !jobData) throw new Error('Job not found');

  // 3. 模拟 AI 处理每个资产
  for (const asset of jobData.job_assets) {
    await (supabaseAdmin.from('job_assets') as any).update({ status: 'processing' }).eq('id', asset.id);

    await new Promise(resolve => setTimeout(resolve, 2000));

    await (supabaseAdmin.from('job_assets') as any).update({
      status: 'processed',
      processed_key: asset.r2_key
    }).eq('id', asset.id);
  }

  // 4. 创建 ZIP 打包
  const zipKey = `u/${jobData.user_id}/jobs/${jobId}/result.zip`;

  await (supabaseAdmin.from('jobs') as any).update({
    status: 'completed',
    zip_key: zipKey
  }).eq('id', jobId);

  console.log(`Legacy job ${jobId} completed!`);
};

const worker = new Worker('job-queue', async (job: Job) => {
  const { jobId } = job.data as { jobId?: string };
  if (!jobId) return;
  console.log(`Worker processing job ${jobId}...`);

  try {
    const { data: jobRecord } = await (supabaseAdmin
      .from('jobs') as any)
      .select('id, workflow_id')
      .eq('id', jobId)
      .single();

    if (jobRecord?.workflow_id) {
      await processPipelineJob(jobId);
    } else {
      await processLegacyJob(jobId);
    }
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    const message = (error as Error).message;
    await (supabaseAdmin.from('jobs') as any)
      .update({ status: 'failed', error_message: message })
      .eq('id', jobId);
    await releaseCreditsForFailure(jobId, message);
    throw error;
  }
}, {
  connection: createRedis(),
  concurrency: 2,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 }
});

const workerEvents = new QueueEvents('job-queue', { connection: createRedis() });

workerEvents.on('completed', ({ jobId }) => {
  console.log(`${jobId} has completed!`);
});

workerEvents.on('failed', ({ jobId, failedReason }) => {
  console.log(`${jobId} has failed with ${failedReason}`);
});

console.log('Worker started...');
