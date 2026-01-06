import { Router, Request, Response } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { supabaseAdmin } from '../services/supabase.js';
import { RAW_BUCKET, getPresignedGetUrl } from '../services/r2.js';
import { createRunningHubTask, pollRunningHub } from '../services/runninghub.js';
import { createRedis } from '../services/redis.js';

const router = Router();

router.use('/admin', authenticate, requireAdmin);

const resolveProvider = async (providerId?: string, providerName?: string) => {
  if (providerId) {
    const { data } = await (supabaseAdmin.from('workflow_providers') as any)
      .select('id, name, base_url, create_path, status_path, status_mode')
      .eq('id', providerId)
      .single();
    return data;
  }
  if (providerName) {
    const { data } = await (supabaseAdmin.from('workflow_providers') as any)
      .select('id, name, base_url, create_path, status_path, status_mode')
      .eq('name', providerName)
      .single();
    return data;
  }
  const { data } = await (supabaseAdmin.from('workflow_providers') as any)
    .select('id, name, base_url, create_path, status_path, status_mode')
    .eq('name', 'runninghub_ai')
    .single();
  return data;
};

// lightweight metrics for queue/eta
const metricsRedis = (() => {
  try {
    return createRedis();
  } catch (err) {
    console.warn('metrics redis unavailable', (err as Error).message);
    return null;
  }
})();

const RUNPOD_HDR_EST_SEC = Number.parseInt(process.env.RUNPOD_HDR_EST_SEC || '180', 10);
const RUNPOD_MAX_CONCURRENCY = Number.parseInt(process.env.RUNPOD_MAX_CONCURRENCY || '4', 10);

router.get('/admin/metrics', async (_req: Request, res: Response) => {
  let runpodPending = 0;
  let runpodCount = 0;
  let runpodTotalMs = 0;
  let runpodFail = 0;
  try {
    if (metricsRedis) {
      const [pending, totalMs, count, fail] = await metricsRedis.mget(
        'runpod:queue:pending',
        'runpod:hdr:total_ms',
        'runpod:hdr:count',
        'runpod:hdr:fail'
      );
      runpodPending = Math.max(Number(pending) || 0, 0);
      runpodTotalMs = Math.max(Number(totalMs) || 0, 0);
      runpodCount = Math.max(Number(count) || 0, 0);
      runpodFail = Math.max(Number(fail) || 0, 0);
    }
  } catch (err) {
    console.warn('metrics read failed', (err as Error).message);
  }
  const avgHdrSec = runpodCount > 0 && runpodTotalMs > 0 ? Math.round((runpodTotalMs / runpodCount) / 1000) : RUNPOD_HDR_EST_SEC;
  const etaSeconds = Math.max(0, Math.ceil((runpodPending / Math.max(RUNPOD_MAX_CONCURRENCY, 1)) * avgHdrSec));
  res.json({
    runpod_pending: runpodPending,
    runpod_hdr_count: runpodCount,
    runpod_hdr_avg_seconds: avgHdrSec,
    runpod_hdr_fail: runpodFail,
    runpod_eta_seconds: etaSeconds,
    runpod_max_concurrency: RUNPOD_MAX_CONCURRENCY,
    runpod_hdr_est_sec: RUNPOD_HDR_EST_SEC
  });
});

router.get('/admin/workflows', async (_req: Request, res: Response) => {
  const { data, error } = await (supabaseAdmin.from('workflows') as any)
    .select(`
      id,
      slug,
      display_name,
      description,
      credit_per_unit,
      is_active,
      preview_original,
      preview_processed,
      is_hidden,
      sort_order,
      provider_id,
      workflow_providers(name),
      workflow_versions(id, version, is_published, workflow_remote_id)
    `)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const workflows = (data || []).map((workflow: any) => {
    const published = (workflow.workflow_versions || []).find((version: any) => version.is_published);
    return {
      ...workflow,
      provider_name: workflow.workflow_providers?.name || null,
      published_version: published || null
    };
  });

  res.json(workflows);
});

router.post('/admin/workflows', async (req: Request, res: Response) => {
  const {
    slug,
    display_name,
    description,
    credit_per_unit,
    is_active,
    is_hidden,
    sort_order,
    preview_original,
    preview_processed,
    provider_id,
    provider_name,
    workflow_remote_id,
    input_node_key,
    input_node_id,
    output_node_id,
    api_mode,
    runtime_config
  } = req.body || {};

  if (!slug || !display_name) return res.status(400).json({ error: 'slug and display_name are required' });

  const provider = await resolveProvider(provider_id, provider_name);
  if (!provider) return res.status(400).json({ error: 'Provider not found' });

  const { data: workflow, error } = await (supabaseAdmin.from('workflows') as any)
    .insert({
      slug,
      display_name,
      description: description || null,
      credit_per_unit: credit_per_unit ?? 1,
      is_active: is_active ?? true,
      is_hidden: is_hidden ?? false,
      sort_order: typeof sort_order === 'number' ? sort_order : 0,
      preview_original: preview_original || null,
      preview_processed: preview_processed || null,
      provider_id: provider.id
    })
    .select()
    .single();

  if (error || !workflow) return res.status(500).json({ error: error?.message || 'Failed to create workflow' });

  if (workflow_remote_id) {
    const baseRuntimeConfig = runtime_config || {};
    if (api_mode) baseRuntimeConfig.api_mode = api_mode;
    if (input_node_id) baseRuntimeConfig.input_node_id = input_node_id;
    if (output_node_id) baseRuntimeConfig.output_node_id = output_node_id;
    const versionPayload = {
      id: uuidv4(),
      workflow_id: workflow.id,
      version: 1,
      workflow_remote_id,
      input_schema: {},
      output_schema: {},
      runtime_config: {
        ...baseRuntimeConfig,
        input_node_key: input_node_key || (runtime_config?.input_node_key ?? 'main_input')
      },
      notes: 'Initial version',
      is_published: true
    };
    const { error: versionError } = await (supabaseAdmin.from('workflow_versions') as any)
      .insert(versionPayload);
    if (versionError) return res.status(500).json({ error: versionError.message });
  }

  res.json(workflow);
});

router.patch('/admin/workflows/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    display_name,
    description,
    credit_per_unit,
    is_active,
    is_hidden,
    sort_order,
    preview_original,
    preview_processed,
    provider_id,
    provider_name
  } = req.body || {};

  const updates: Record<string, any> = {};
  if (display_name !== undefined) updates.display_name = display_name;
  if (description !== undefined) updates.description = description;
  if (credit_per_unit !== undefined) updates.credit_per_unit = credit_per_unit;
  if (is_active !== undefined) updates.is_active = is_active;
  if (is_hidden !== undefined) updates.is_hidden = is_hidden;
  if (sort_order !== undefined) updates.sort_order = sort_order;
  if (preview_original !== undefined) updates.preview_original = preview_original;
  if (preview_processed !== undefined) updates.preview_processed = preview_processed;

  if (provider_id || provider_name) {
    const provider = await resolveProvider(provider_id, provider_name);
    if (!provider) return res.status(400).json({ error: 'Provider not found' });
    updates.provider_id = provider.id;
  }

  const { data, error } = await (supabaseAdmin.from('workflows') as any)
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/admin/workflows/:id/versions', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { data, error } = await (supabaseAdmin.from('workflow_versions') as any)
    .select('id, version, workflow_remote_id, input_schema, output_schema, runtime_config, notes, is_published, created_at')
    .eq('workflow_id', id)
    .order('version', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.patch('/admin/workflows/:id/versions/:versionId', async (req: Request, res: Response) => {
  const { id, versionId } = req.params;
  const {
    workflow_remote_id,
    runtime_config,
    notes,
    input_node_key,
    input_node_id,
    output_node_id,
    api_mode
  } = req.body || {};

  const { data: existing, error: existingError } = await (supabaseAdmin.from('workflow_versions') as any)
    .select('id, runtime_config')
    .eq('workflow_id', id)
    .eq('id', versionId)
    .single();

  if (existingError || !existing) return res.status(404).json({ error: 'Version not found' });

  const mergedRuntime = { ...(existing.runtime_config || {}), ...(runtime_config || {}) };
  if (api_mode) mergedRuntime.api_mode = api_mode;
  if (input_node_key) mergedRuntime.input_node_key = input_node_key;
  if (input_node_id) mergedRuntime.input_node_id = input_node_id;
  if (output_node_id) mergedRuntime.output_node_id = output_node_id;

  const updates: Record<string, any> = {
    runtime_config: mergedRuntime
  };
  if (workflow_remote_id !== undefined) updates.workflow_remote_id = workflow_remote_id;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await (supabaseAdmin.from('workflow_versions') as any)
    .update(updates)
    .eq('workflow_id', id)
    .eq('id', versionId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/admin/workflows/:id/versions', async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    workflow_remote_id,
    input_schema,
    output_schema,
    runtime_config,
    notes,
    is_published,
    input_node_key,
    input_node_id,
    output_node_id,
    api_mode
  } = req.body || {};
  if (!workflow_remote_id) return res.status(400).json({ error: 'workflow_remote_id is required' });

  const { data: latest } = await (supabaseAdmin.from('workflow_versions') as any)
    .select('version')
    .eq('workflow_id', id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latest?.version || 0) + 1;
  const mergedRuntime = runtime_config || {};
  if (api_mode) mergedRuntime.api_mode = api_mode;
  if (input_node_key) mergedRuntime.input_node_key = input_node_key;
  if (input_node_id) mergedRuntime.input_node_id = input_node_id;
  if (output_node_id) mergedRuntime.output_node_id = output_node_id;

  const payload = {
    id: uuidv4(),
    workflow_id: id,
    version: nextVersion,
    workflow_remote_id,
    input_schema: input_schema || {},
    output_schema: output_schema || {},
    runtime_config: mergedRuntime,
    notes: notes || null,
    is_published: Boolean(is_published)
  };

  const { data: version, error } = await (supabaseAdmin.from('workflow_versions') as any)
    .insert(payload)
    .select()
    .single();

  if (error || !version) return res.status(500).json({ error: error?.message || 'Failed to create version' });

  if (payload.is_published) {
    await (supabaseAdmin.from('workflow_versions') as any)
      .update({ is_published: false })
      .eq('workflow_id', id)
      .neq('id', version.id);
  }

  res.json(version);
});

router.post('/admin/workflows/:id/publish/:versionId', async (req: Request, res: Response) => {
  const { id, versionId } = req.params;

  await (supabaseAdmin.from('workflow_versions') as any)
    .update({ is_published: false })
    .eq('workflow_id', id);

  const { data, error } = await (supabaseAdmin.from('workflow_versions') as any)
    .update({ is_published: true })
    .eq('workflow_id', id)
    .eq('id', versionId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/admin/workflows/:id/test-run', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { input_url, r2_key, r2_bucket } = req.body || {};

    const { data: version, error: versionError } = await (supabaseAdmin.from('workflow_versions') as any)
      .select('id, workflow_remote_id, input_schema, runtime_config, workflows(provider_id)')
      .eq('workflow_id', id)
      .eq('is_published', true)
      .single();

    if (versionError || !version) return res.status(400).json({ error: 'No published workflow version' });

    const { data: provider } = await (supabaseAdmin.from('workflow_providers') as any)
      .select('id, name, base_url, create_path, status_path, status_mode')
      .eq('id', version.workflows?.provider_id)
      .single();

    if (!provider) return res.status(400).json({ error: 'Provider not found' });

    let inputUrl = input_url;
    if (!inputUrl && r2_key) {
      const bucket = r2_bucket || RAW_BUCKET;
      inputUrl = await getPresignedGetUrl(bucket, r2_key, 900);
    }

    if (!inputUrl) return res.status(400).json({ error: 'input_url or r2_key is required' });

    const runtimeConfig = (version.runtime_config || {}) as Record<string, unknown>;
    const inputKey = (runtimeConfig.input_node_key as string | undefined) || 'main_input';

    const created = await createRunningHubTask(provider, version.workflow_remote_id, inputKey, inputUrl, runtimeConfig);
    const status = await pollRunningHub(provider, created.taskId, runtimeConfig);

    res.json({
      task_id: created.taskId,
      status: status.status,
      output_urls: status.outputUrls,
      raw_create: created.raw,
      raw_status: status.raw
    });
  } catch (error) {
    const axiosError = axios.isAxiosError(error) ? error : null;
    const detail = axiosError?.response?.data || (error as Error).message || String(error);
    console.error('Admin test-run failed:', detail);
    res.status(502).json({ error: 'Test-run failed', detail });
  }
});

router.get('/admin/credits', async (_req: Request, res: Response) => {
  const { data: profiles, error: profileError } = await (supabaseAdmin.from('profiles') as any)
    .select('id, email, is_admin');
  if (profileError) return res.status(500).json({ error: profileError.message });

  const { data: balances, error: balanceError } = await (supabaseAdmin.from('credit_balances') as any)
    .select('user_id, available_credits, reserved_credits');
  if (balanceError) return res.status(500).json({ error: balanceError.message });

  const balanceMap = new Map<string, { available_credits?: number | null; reserved_credits?: number | null }>(
    (balances || []).map((balance: any) => [balance.user_id, balance])
  );
  const rows = (profiles || []).map((profile: any) => {
    const balance = balanceMap.get(profile.id);
    return {
      user_id: profile.id,
      email: profile.email,
      is_admin: profile.is_admin,
      available_credits: balance?.available_credits ?? 0,
      reserved_credits: balance?.reserved_credits ?? 0
    };
  });

  res.json(rows);
});

router.get('/admin/jobs', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const { data: jobs, error } = await (supabaseAdmin.from('jobs') as any)
    .select('id, user_id, project_name, status, error_message, workflow_id, created_at, estimated_units, settled_units, reserved_units, progress')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  if (!jobs || jobs.length === 0) return res.json([]);

  const jobIds = jobs.map((job: any) => job.id);
  const userIds = Array.from(new Set(jobs.map((job: any) => job.user_id)));
  const { data: groups } = await (supabaseAdmin.from('job_groups') as any)
    .select('job_id, group_index, last_error')
    .in('job_id', jobIds)
    .eq('status', 'failed');

  const grouped = new Map<string, { group_index: number; last_error: string | null }[]>();
  (groups || []).forEach((group: any) => {
    const list = grouped.get(group.job_id) || [];
    list.push({ group_index: group.group_index, last_error: group.last_error || null });
    grouped.set(group.job_id, list);
  });

  const { data: groupCounts } = await (supabaseAdmin.from('job_groups') as any)
    .select('job_id, status')
    .in('job_id', jobIds);

  const { data: fileCounts } = await (supabaseAdmin.from('job_files') as any)
    .select('job_id')
    .in('job_id', jobIds);

  const { data: workflows } = await (supabaseAdmin.from('workflows') as any)
    .select('id, credit_per_unit');

  const { data: profiles } = await (supabaseAdmin.from('profiles') as any)
    .select('id, email')
    .in('id', userIds);

  const groupSummary = new Map<string, { total: number; done: number }>();
  (groupCounts || []).forEach((row: any) => {
    const current = groupSummary.get(row.job_id) || { total: 0, done: 0 };
    current.total += 1;
    if (row.status === 'ai_ok') current.done += 1;
    groupSummary.set(row.job_id, current);
  });

  const fileSummary = new Map<string, number>();
  (fileCounts || []).forEach((row: any) => {
    const current = fileSummary.get(row.job_id) || 0;
    fileSummary.set(row.job_id, current + 1);
  });

  const workflowMap = new Map<string, number>();
  (workflows || []).forEach((wf: any) => {
    workflowMap.set(wf.id, wf.credit_per_unit || 1);
  });

  const profileMap = new Map<string, string | null>();
  (profiles || []).forEach((p: any) => {
    profileMap.set(p.id, p.email || null);
  });

  const payload = jobs.map((job: any) => {
    const summary = groupSummary.get(job.id) || { total: 0, done: 0 };
    const creditPerUnit = job.workflow_id ? (workflowMap.get(job.workflow_id) || 1) : 1;
    const creditsUsed = (job.settled_units || 0) * creditPerUnit;
    return {
      ...job,
      group_errors: grouped.get(job.id) || [],
      group_total: summary.total,
      group_done: summary.done,
      photo_count: fileSummary.get(job.id) || 0,
      credits_used: creditsUsed,
      user_email: profileMap.get(job.user_id) || null
    };
  });
  res.json(payload);
});

router.post('/admin/credits/adjust', async (req: Request, res: Response) => {
  const { user_id, delta, note, idempotency_key } = req.body || {};
  if (!user_id || !Number.isInteger(delta)) {
    return res.status(400).json({ error: 'user_id and integer delta are required' });
  }

  const key = idempotency_key || `admin_adjust:${user_id}:${Date.now()}`;
  const { data, error } = await (supabaseAdmin as any).rpc('credit_admin_adjust', {
    p_user_id: user_id,
    p_delta: delta,
    p_idempotency_key: key,
    p_note: note || null
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
