import { Worker, Job } from 'bullmq';
import { supabaseAdmin } from './services/supabase.js';
import { r2Client, BUCKET_NAME } from './services/r2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import dotenv from 'dotenv';
import { redisConnection } from './services/redis.js';

// 加载环境变量
dotenv.config();

const worker = new Worker('job-queue', async (job: Job) => {
    const { jobId } = job.data;
    console.log(`Processing job ${jobId}...`);

    try {
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

        console.log(`Job ${jobId} completed!`);

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        await (supabaseAdmin.from('jobs') as any).update({ status: 'failed' }).eq('id', jobId);
        throw error;
    }
}, { connection: redisConnection });

worker.on('completed', job => {
    console.log(`${job.id} has completed!`);
});

worker.on('failed', (job, err) => {
    console.log(`${job?.id} has failed with ${err.message}`);
});

console.log('Worker started with shared connection...');
