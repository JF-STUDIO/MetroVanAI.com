import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { AuthRequest } from '../types/auth.js';

export const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await (supabaseAdmin.from('profiles') as any)
    .select('is_admin')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data?.is_admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
};
