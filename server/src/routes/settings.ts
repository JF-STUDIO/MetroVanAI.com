import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { getFreeTrialPoints, setFreeTrialPoints } from '../services/settings.js';

const router = Router();

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const freeTrialPoints = await getFreeTrialPoints();
    res.json({ free_trial_points: freeTrialPoints });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to load settings', detail });
  }
});

router.use('/admin', authenticate, requireAdmin);

router.get('/admin/settings', async (_req: Request, res: Response) => {
  try {
    const freeTrialPoints = await getFreeTrialPoints();
    res.json({ free_trial_points: freeTrialPoints });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to load settings', detail });
  }
});

router.patch('/admin/settings', async (req: Request, res: Response) => {
  const { free_trial_points } = req.body || {};
  const parsed = Number(free_trial_points);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return res.status(400).json({ error: 'free_trial_points must be a non-negative number' });
  }
  try {
    const updated = await setFreeTrialPoints(parsed);
    res.json(updated);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to update settings', detail });
  }
});

export default router;
