import './config.js';
import { Worker, Job } from 'bullmq';
import { createReadStream } from 'fs';
import path from 'path';
import axios from 'axios';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { supabaseAdmin } from './services/supabase.js';
import {
  r2Client,
  RAW_BUCKET,
  HDR_BUCKET,
  OUTPUT_BUCKET,
  getPresignedGetUrl,
  deleteObject
} from './services/r2.js';
import { createRedis } from './services/redis.js';
import { createHdrForGroup, cleanupHdrTemp } from './services/hdr.js';
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

const downloadOutputToR2 = async (outputUrl: string, bucket: string, key: string) => {
  const response = await axios.get(outputUrl, { responseType: 'arraybuffer' });
  const contentType = response.headers['content-type'] || 'image/jpeg';
  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: response.data,
      ContentType: contentType
    })
  );
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
      status: 'hdr_ok',
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

  let outputExt = '.jpg';
  try {
    outputExt = path.extname(new URL(outputUrl).pathname) || '.jpg';
  } catch {
    outputExt = '.jpg';
  }

  const outputKey = `jobs/${jobId}/${group.id}${outputExt}`;
  await downloadOutputToR2(outputUrl, OUTPUT_BUCKET, outputKey);
  await deleteObject(HDR_BUCKET, group.hdr_key);

  const attempts = (group.attempts || 0) + 1;
  await (supabaseAdmin.from('job_groups') as any)
    .update({
      output_bucket: OUTPUT_BUCKET,
      output_key: outputKey,
      status: 'ai_ok',
      attempts,
      last_error: null
    })
    .eq('id', group.id);
};

const processPipelineJob = async (jobId: string) => {
  const { data: job, error: jobError } = await (supabaseAdmin
    .from('jobs') as any)
    .select('id, user_id, status, workflow_id, workflow_version_id')
    .eq('id', jobId)
    .single();

  if (jobError || !job) throw new Error('Pipeline job not found');
  if (!job.workflow_id || !job.workflow_version_id) throw new Error('Pipeline job missing workflow metadata');

  const context = await fetchWorkflowContext(job.workflow_id, job.workflow_version_id);

  await (supabaseAdmin.from('jobs') as any)
    .update({ status: 'hdr_processing', error_message: null })
    .eq('id', jobId);

  const { data: hdrGroups } = await (supabaseAdmin.from('job_groups') as any)
    .select('id, status, attempts')
    .eq('job_id', jobId)
    .order('group_index', { ascending: true });

  if (!hdrGroups || hdrGroups.length === 0) {
    throw new Error('No job groups found');
  }

  const pendingHdr = ((hdrGroups || []) as any[]).filter((group: any) => group.status === 'queued');
  await runWithConcurrency(pendingHdr, HDR_CONCURRENCY, async (group) => {
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

  await (supabaseAdmin.from('jobs') as any)
    .update({ status: 'ai_processing' })
    .eq('id', jobId);

  const { data: aiGroups } = await (supabaseAdmin.from('job_groups') as any)
    .select('id, status, hdr_key, attempts')
    .eq('job_id', jobId)
    .order('group_index', { ascending: true });

  const pendingAi = ((aiGroups || []) as any[]).filter((group: any) => group.status === 'hdr_ok');
  await runWithConcurrency(pendingAi, AI_CONCURRENCY, async (group) => {
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

  const { data: finalGroups } = await (supabaseAdmin.from('job_groups') as any)
    .select('status')
    .eq('job_id', jobId);

  const total = finalGroups?.length || 0;
  const success = finalGroups?.filter((group: any) => group.status === 'ai_ok').length || 0;
  const failed = finalGroups?.filter((group: any) => group.status === 'failed').length || 0;

  if (total > 0 && success === total) {
    await (supabaseAdmin.from('jobs') as any)
      .update({ status: 'zipping', progress: 100 })
      .eq('id', jobId);
  } else if (failed > 0) {
    await (supabaseAdmin.from('jobs') as any)
      .update({ status: 'partial' })
      .eq('id', jobId);
  }
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
    await (supabaseAdmin.from('jobs') as any)
      .update({ status: 'failed', error_message: (error as Error).message })
      .eq('id', jobId);
    throw error;
  }
}, {
  connection: createRedis(),
  concurrency: 2,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 }
});

const workerEvents = new Worker('job-queue', async () => {}, { connection: createRedis() });

workerEvents.on('completed', (job) => {
  console.log(`${job.id} has completed!`);
});

workerEvents.on('failed', (job, err) => {
  console.log(`${job?.id} has failed with ${err.message}`);
});

console.log('Worker started...');
