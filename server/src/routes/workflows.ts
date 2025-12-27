import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { supabaseAdmin } from '../services/supabase.js';

const router = Router();

router.get('/workflows', authenticate, async (_req: Request, res: Response) => {
  const { data, error } = await (supabaseAdmin
    .from('workflow_versions') as any)
    .select('id, version, workflow_id, workflows(id, slug, display_name, credit_per_unit, is_active)')
    .eq('is_published', true)
    .eq('workflows.is_active', true);

  if (error) return res.status(500).json({ error: error.message });

  const workflows = (data || []).map((row: any) => ({
    id: row.workflows?.id,
    slug: row.workflows?.slug,
    display_name: row.workflows?.display_name,
    credit_per_unit: row.workflows?.credit_per_unit,
    version_id: row.id,
    version: row.version,
  }));

  res.json(workflows);
});

export default router;
