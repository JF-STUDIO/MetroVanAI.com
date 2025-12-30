import { supabaseAdmin } from './supabase.js';

const SETTINGS_TABLE = 'app_settings';
const FREE_TRIAL_KEY = 'free_trial_points';
const PRICING_KEY = 'pricing';
const DEFAULT_TRIAL_POINTS = 10;
const DEFAULT_PRICING = {
  base_rate: 0.25,
  packs: [
    { label: 'Starter Boost', amount: 100, bonus: 40 },
    { label: 'Growth Pack', amount: 500, bonus: 250 },
    { label: 'Studio Scale', amount: 1000, bonus: 500 }
  ]
};

export type PricingPack = {
  label: string;
  amount: number;
  bonus: number;
};

export type PricingSettings = {
  base_rate: number;
  packs: PricingPack[];
};

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

const coerceNumber = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const normalizePricing = (value: unknown): PricingSettings => {
  if (!value || typeof value !== 'object') {
    return DEFAULT_PRICING;
  }
  const record = value as Record<string, unknown>;
  const baseRate = coerceNumber(record.base_rate ?? record.baseRate, DEFAULT_PRICING.base_rate);
  const packsInput = Array.isArray(record.packs) ? record.packs : [];
  const packs: PricingPack[] = packsInput
    .map((pack, index) => {
      if (!pack || typeof pack !== 'object') return null;
      const packRecord = pack as Record<string, unknown>;
      const amount = coerceNumber(packRecord.amount, NaN);
      const bonus = coerceNumber(packRecord.bonus, 0);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const label = typeof packRecord.label === 'string' && packRecord.label.trim().length > 0
        ? packRecord.label.trim()
        : DEFAULT_PRICING.packs[index]?.label || `Pack ${index + 1}`;
      return {
        label,
        amount: Math.round(amount),
        bonus: Math.max(0, Math.round(bonus))
      };
    })
    .filter(Boolean) as PricingPack[];

  return {
    base_rate: baseRate > 0 ? baseRate : DEFAULT_PRICING.base_rate,
    packs: packs.length > 0 ? packs : DEFAULT_PRICING.packs
  };
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

export const getPricingSettings = async (): Promise<PricingSettings> => {
  const { data, error } = await (supabaseAdmin.from(SETTINGS_TABLE) as any)
    .select('value')
    .eq('key', PRICING_KEY)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    await (supabaseAdmin.from(SETTINGS_TABLE) as any)
      .upsert({ key: PRICING_KEY, value: DEFAULT_PRICING });
    return DEFAULT_PRICING;
  }

  return normalizePricing(data.value);
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

export const setPricingSettings = async (pricing: PricingSettings) => {
  const normalized = normalizePricing(pricing);
  const { data, error } = await (supabaseAdmin.from(SETTINGS_TABLE) as any)
    .upsert({ key: PRICING_KEY, value: normalized })
    .select('key, value')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return {
    pricing: normalizePricing(data?.value)
  };
};
