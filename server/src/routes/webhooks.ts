
import { Router } from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { emitJobEvent } from '../services/jobEvents.js';

const router = Router();

// Handle RunPod HDR completion webhook
router.post('/runpod/hdr', async (req, res) => {
    const { id, status, output, error } = req.body;
    // RunPod payload structure: { id, status: "COMPLETED" | "FAILED", output: { ... }, error: ... }
    // OR if custom callback from handler.py: { jobId, groups: [...], uploads: [...], error: ... }

    // Check if this is a native RunPod webhook or our manual callback
    // Our manual callback (from handler.py) sends { jobId, groups, ... } directly.
    // Native webhook sends { id: "taskId", status, output: { ...resultFromHandler... } }

    let jobId: string | undefined;
    let groupsData: any[] = [];
    let isError = false;
    let errorMessage: string | undefined;

    // Case 1: Manual callback from handler.py (direct POST)
    if (req.body.jobId) {
        jobId = req.body.jobId;
        groupsData = req.body.groups || [];
        if (req.body.error) {
            isError = true;
            errorMessage = req.body.error;
        }
    }
    // Case 2: RunPod Native Webhook
    else if (output && output.jobId) {
        jobId = output.jobId;
        groupsData = output.groups || [];
        if (status === 'FAILED' || error) {
            isError = true;
            errorMessage = error || output.error || 'RunPod task failed';
        }
    }
    // Case 3: RunPod Native Webhook (Failure with no output)
    else if (status === 'FAILED') {
        // We might not have the jobId if it completely crashed before returning it in output.
        // In this case, we rely on the backend tracking the taskId -> jobId mapping (if we implemented that).
        // For now, if we can't find jobId, we can't update DB.
        console.error('RunPod webhook failed without jobId in output:', req.body);
        return res.status(200).json({ received: true }); // Ack even if we can't process
    }

    if (!jobId) {
        // Fallback: maybe we passed it in query params?
        // Not implemented in runpod.ts yet, but good for future.
        console.warn('RunPod webhook missing jobId:', req.body);
        return res.status(200).json({ received: true });
    }

    console.log(`Received RunPod webhook for Job ${jobId}`, { isError, groupsCount: groupsData.length });

    try {
        if (isError) {
            // Mark relevant groups as failed? 
            // Since we might not know WHICH group failed if it was a batch, 
            // but our design is "one group per task", so we should ideally know the groupId.
            // The handler.py should return groupId in the error case too if possible.

            // For now, let's log it. The backend poller or user will see it eventually?
            // Better: Update the specific group if we can find it.
            // In our robust design, we sent 'groupId' to runpod.
        } else {
            // Success
            for (const g of groupsData) {
                // g: { index, resultKey, previewKey, representativeId... }
                // We need to match this to a job_group row.
                // Ideally we sent the group_id to RunPod and it echoed it back.
                // Let's assume handler.py echoes 'groupId' if we sent it in 'input'.

                // Update job_group
                // We expect 'resultKey' to be the HDR output in R2.

                const groupIndex = g.index; // 1-based index from handler? or we use g.groupId if available

                // Find the group
                let query = supabaseAdmin.from('job_groups').update({
                    status: 'hdr_ok',
                    hdr_bucket: process.env.HDR_BUCKET || 'mvai-hdr', // Assumed bucket
                    hdr_key: g.resultKey,
                    updated_at: new Date().toISOString()
                }).eq('job_id', jobId);

                if (g.groupId) {
                    query = query.eq('id', g.groupId);
                } else if (typeof groupIndex === 'number') {
                    query = query.eq('group_index', groupIndex);
                }

                const { error: updateError } = await query;
                if (updateError) {
                    console.error('Failed to update group status:', updateError);
                } else {
                    // Emit event
                    emitJobEvent(jobId, {
                        type: 'group_status_changed',
                        group_id: g.groupId,
                        status: 'hdr_ok',
                        index: (groupIndex || 1) - 1
                    });
                }
            }

            // Check if all groups are done? 
            // The polling/worker logic usually handles the transition to AI.
            // But we can trigger it here to be faster.
            // Actually, the main 'pipeline-job' in worker.ts polls or checks status. 
            // If we want event-driven, we could enqueue a 'check-job' task.
        }
    } catch (err) {
        console.error('Webhook processing error:', err);
    }

    res.json({ success: true });
});

export default router;
