import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { getFreeTrialPoints, getPricingSettings, setFreeTrialPoints, setPricingSettings } from '../services/settings.js';

const router = Router();

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const freeTrialPoints = await getFreeTrialPoints();
    const pricing = await getPricingSettings();
    res.json({ free_trial_points: freeTrialPoints, pricing });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to load settings', detail });
  }
});

router.use('/admin', authenticate, requireAdmin);

router.get('/admin/settings', async (_req: Request, res: Response) => {
  try {
    const freeTrialPoints = await getFreeTrialPoints();
    const pricing = await getPricingSettings();
    res.json({ free_trial_points: freeTrialPoints, pricing });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to load settings', detail });
  }
});

router.patch('/admin/settings', async (req: Request, res: Response) => {
  try {
    const { free_trial_points, pricing } = req.body || {};
    const responsePayload: Record<string, unknown> = {};

    if (typeof free_trial_points !== 'undefined') {
      const parsed = Number(free_trial_points);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ error: 'free_trial_points must be a non-negative number' });
      }
      const updated = await setFreeTrialPoints(parsed);
      responsePayload.free_trial_points = updated.free_trial_points;
    }

    if (typeof pricing !== 'undefined') {
      const updated = await setPricingSettings(pricing);
      responsePayload.pricing = updated.pricing;
    }

    if (Object.keys(responsePayload).length === 0) {
      return res.status(400).json({ error: 'No settings provided' });
    }

    res.json(responsePayload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to update settings', detail });
  }
});

export default router;
