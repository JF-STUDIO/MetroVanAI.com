import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { supabaseAdmin } from '../services/supabase.js';
import { RAW_BUCKET, getPresignedGetUrl } from '../services/r2.js';
import { createRunningHubTask, pollRunningHub } from '../services/runninghub.js';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

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
      provider_id,
      workflow_providers(name),
      workflow_versions(id, version, is_published, workflow_remote_id)
    `)
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
    preview_original,
    preview_processed,
    provider_id,
    provider_name,
    workflow_remote_id,
    input_node_key,
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
      preview_original: preview_original || null,
      preview_processed: preview_processed || null,
      provider_id: provider.id
    })
    .select()
    .single();

  if (error || !workflow) return res.status(500).json({ error: error?.message || 'Failed to create workflow' });

  if (workflow_remote_id) {
    const versionPayload = {
      id: uuidv4(),
      workflow_id: workflow.id,
      version: 1,
      workflow_remote_id,
      input_schema: {},
      output_schema: {},
      runtime_config: {
        ...(runtime_config || {}),
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

router.post('/admin/workflows/:id/versions', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { workflow_remote_id, input_schema, output_schema, runtime_config, notes, is_published } = req.body || {};
  if (!workflow_remote_id) return res.status(400).json({ error: 'workflow_remote_id is required' });

  const { data: latest } = await (supabaseAdmin.from('workflow_versions') as any)
    .select('version')
    .eq('workflow_id', id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latest?.version || 0) + 1;
  const payload = {
    id: uuidv4(),
    workflow_id: id,
    version: nextVersion,
    workflow_remote_id,
    input_schema: input_schema || {},
    output_schema: output_schema || {},
    runtime_config: runtime_config || {},
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
