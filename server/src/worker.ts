import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { supabaseAdmin } from './services/supabase';
import { r2Client, BUCKET_NAME } from './services/r2';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import axios from 'axios';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import dotenv from 'dotenv';

dotenv.config();

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const RUNNINGHUB_API_KEY = process.env.RUNNINGHUB_API_KEY;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const worker = new Worker('job-queue', async (job: Job) => {
  const { jobId } = job.data;
  console.log(`Processing job: ${jobId}`);

  try {
    // 1. 获取任务详情
    const { data: jobData, error: jobErr } = await supabaseAdmin
      .from('jobs')
      .select('*, photo_tools(*), job_assets(*)')
      .eq('id', jobId)
      .single();

    if (jobErr || !jobData) throw new Error('Job not found');

    await supabaseAdmin.from('jobs').update({ status: 'processing' }).eq('id', jobId);

    const tool = jobData.photo_tools;
    const assets = jobData.job_assets;
    const userId = jobData.user_id;

    // 2. 检查并预扣积分
    const totalCost = assets.length * tool.point_cost;
    const { data: profile } = await supabaseAdmin.from('profiles').select('points').eq('id', userId).single();
    
    if (!profile || profile.points < totalCost) {
        throw new Error('Insufficient points');
    }

    // 扣除积分并记录流水
    await supabaseAdmin.from('profiles').update({ points: profile.points - totalCost }).eq('id', userId);
    await supabaseAdmin.from('transactions').insert({
        user_id: userId,
        amount: -totalCost,
        type: 'consume',
        description: `Consumed for job ${jobId}`,
        job_id: jobId
    });

    // 3. 逐个处理资产
    for (const asset of assets) {
      try {
        const getCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: asset.r2_key });
        const downloadUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 3600 });

        const rhResponse = await axios.post('https://api.runninghub.ai/task/openapi/create', {
          workflow_id: tool.workflow_id,
          input_data: {
            [tool.input_node_key]: downloadUrl
          }
        }, {
          headers: { 'Authorization': `Bearer ${RUNNINGHUB_API_KEY}` }
        });

        const rhTaskId = rhResponse.data.data.task_id;
        await supabaseAdmin.from('job_assets').update({ 
            runninghub_task_id: rhTaskId,
            status: 'processing' 
        }).eq('id', asset.id);

        let status = 'PENDING';
        let outputUrl = '';
        let retries = 0;
        while (status !== 'SUCCESS' && status !== 'FAILED' && retries < 60) {
          await sleep(5000);
          const statusRes = await axios.get(`https://api.runninghub.ai/task/openapi/status?task_id=${rhTaskId}`, {
            headers: { 'Authorization': `Bearer ${RUNNINGHUB_API_KEY}` }
          });
          status = statusRes.data.data.status;
          if (status === 'SUCCESS') {
            outputUrl = statusRes.data.data.outputs[0].url;
          }
          retries++;
        }

        if (status === 'SUCCESS' && outputUrl) {
          const resStream = await axios.get(outputUrl, { responseType: 'stream' });
          const outKey = asset.r2_key.replace('/raw/', '/out/').replace(/\.[^.]+$/, '.jpg');
          
          const { Upload } = require("@aws-sdk/lib-storage");
          const parallelUploads3 = new Upload({
            client: r2Client,
            params: {
              Bucket: BUCKET_NAME,
              Key: outKey,
              Body: resStream.data,
              ContentType: 'image/jpeg'
            },
          });
          await parallelUploads3.done();

          await supabaseAdmin.from('job_assets').update({ 
            status: 'processed',
            r2_output_key: outKey 
          }).eq('id', asset.id);
        } else {
          throw new Error(`RunningHub failed or timed out for asset ${asset.id}`);
        }
      } catch (assetErr: any) {
        console.error(`Error processing asset ${asset.id}:`, assetErr.message);
        await supabaseAdmin.from('job_assets').update({ status: 'failed' }).eq('id', asset.id);
        await supabaseAdmin.from('job_events').insert({
            job_id: jobId,
            event_type: 'asset_failed',
            message: assetErr.message,
            payload: { assetId: asset.id }
        });
      }
    }

    // 4. 生成 ZIP
    const processedAssets = (await supabaseAdmin.from('job_assets').select('*').eq('job_id', jobId).eq('status', 'processed')).data;

    if (processedAssets && processedAssets.length > 0) {
      const zipKey = `u/${userId}/jobs/${jobId}/zip/${jobId}.zip`;
      const archive = archiver('zip', { zlib: { level: 9 } });
      const passthrough = new PassThrough();

      const { Upload } = require("@aws-sdk/lib-storage");
      const zipUpload = new Upload({
        client: r2Client,
        params: {
          Bucket: BUCKET_NAME,
          Key: zipKey,
          Body: passthrough,
          ContentType: 'application/zip'
        },
      });

      archive.pipe(passthrough);
      for (const asset of processedAssets) {
          const getCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: asset.r2_output_key! });
          const response = await r2Client.send(getCommand);
          if (response.Body) {
            archive.append(response.Body as any, { name: asset.r2_output_key!.split('/').pop()! });
          }
      }

      await archive.finalize();
      await zipUpload.done();

      await supabaseAdmin.from('jobs').update({ 
        status: 'completed', 
        zip_key: zipKey,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      }).eq('id', jobId);
    } else {
      throw new Error('No assets were successfully processed');
    }

  } catch (err: any) {
    console.error(`Job ${jobId} failed:`, err.message);
    await supabaseAdmin.from('jobs').update({ 
        status: 'failed', 
        error_message: err.message 
    }).eq('id', jobId);
  }
}, { connection });

console.log('Worker is running...');
