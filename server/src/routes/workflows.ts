import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { supabaseAdmin } from '../services/supabase.js';

const router = Router();

router.get('/workflows', authenticate, async (_req: Request, res: Response) => {
  const { data, error } = await (supabaseAdmin
    .from('workflows') as any)
    .select(`
      id,
      slug,
      display_name,
      description,
      credit_per_unit,
      preview_original,
      preview_processed,
      is_active,
      workflow_versions(id, version, is_published)
    `)
    .eq('is_active', true)
    .eq('workflow_versions.is_published', true);

  if (error) return res.status(500).json({ error: error.message });

  const workflows = (data || []).map((row: any) => {
    const published = (row.workflow_versions || [])[0];
    return {
      id: row.id,
      slug: row.slug,
      display_name: row.display_name,
      description: row.description,
      credit_per_unit: row.credit_per_unit,
      preview_original: row.preview_original,
      preview_processed: row.preview_processed,
      version_id: published?.id || null,
      version: published?.version || null
    };
  });

  res.json(workflows);
});

export default router;
