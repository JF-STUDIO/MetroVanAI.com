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
      is_hidden,
      sort_order,
      is_active,
      workflow_versions(id, version, is_published)
    `)
    .eq('is_active', true)
    .eq('is_hidden', false)
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
      sort_order: row.sort_order ?? 0,
      version_id: published?.id || null,
      version: published?.version || null
    };
  });

  const sorted = workflows.sort((a: any, b: any) => {
    const orderA = a.sort_order ?? 0;
    const orderB = b.sort_order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.display_name.localeCompare(b.display_name);
  });

  res.json(sorted);
});

export default router;
