import { supabaseAdmin } from './supabase.js';

const SETTINGS_TABLE = 'app_settings';
const FREE_TRIAL_KEY = 'free_trial_points';
const DEFAULT_TRIAL_POINTS = 10;

const parseNumericSetting = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nested = record.points ?? record.value ?? record.free_trial_points;
    return parseNumericSetting(nested, fallback);
  }
  return fallback;
};

export const getFreeTrialPoints = async (): Promise<number> => {
  const { data, error } = await (supabaseAdmin.from(SETTINGS_TABLE) as any)
    .select('value')
    .eq('key', FREE_TRIAL_KEY)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    await (supabaseAdmin.from(SETTINGS_TABLE) as any)
      .upsert({ key: FREE_TRIAL_KEY, value: DEFAULT_TRIAL_POINTS });
    return DEFAULT_TRIAL_POINTS;
  }

  return parseNumericSetting(data.value, DEFAULT_TRIAL_POINTS);
};

export const setFreeTrialPoints = async (points: number) => {
  const cleanPoints = Math.max(0, Math.floor(points));
  const { data, error } = await (supabaseAdmin.from(SETTINGS_TABLE) as any)
    .upsert({ key: FREE_TRIAL_KEY, value: cleanPoints })
    .select('key, value')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return {
    free_trial_points: parseNumericSetting(data?.value, cleanPoints)
  };
};
