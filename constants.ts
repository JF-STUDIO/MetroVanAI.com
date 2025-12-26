
import { PhotoTool, CreditPlan } from './types';

export const POINT_PRICE_PER_UNIT = 0.15;

export const RUNNINGHUB_DEFAULT_KEY = 'c0d42f30deb54a7a9ce564c72b5bfe4a';

export const DEFAULT_TOOLS: PhotoTool[] = [
  {
    id: 'real-estate-v1-rh',
    name: 'Real Estate Retouch V1 (Pro)',
    description: 'Elite automatic retouching powered by specialized architectural workflows. Optimized for high-end listing photography.',
    icon: 'fa-building-circle-check',
    promptTemplate: '',
    category: 'Enhancement',
    apiProvider: 'runninghub',
    workflowId: 'c0d42f30deb54a7a9ce564c72b5bfe4a',
    inputNodeKey: 'input_image',
    externalApiKey: RUNNINGHUB_DEFAULT_KEY,
    previewOriginal: 'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&q=80&w=1000',
    previewProcessed: 'https://images.unsplash.com/photo-1600210491892-03d54c0aaf87?auto=format&fit=crop&q=80&w=1000',
    pointCost: 1
  },
  {
    id: 'real-estate-retouch',
    name: 'Real Estate Retouching (AI)',
    description: 'Professional architectural retouching. Balances lighting, recovers shadows, and optimizes color using Gemini Vision.',
    icon: 'fa-wand-magic-sparkles',
    promptTemplate: 'High-end architectural retouching. Balance lighting, recover window details without replacing them, and optimize color for a professional look. Enhance dynamic range and clarity.',
    category: 'Enhancement',
    apiProvider: 'gemini',
    previewOriginal: 'https://images.unsplash.com/photo-1600585154526-990dcea4db0d?auto=format&fit=crop&q=80&w=1000',
    previewProcessed: 'https://images.unsplash.com/photo-1600607687920-4e5873bb3b76?auto=format&fit=crop&q=80&w=1000',
    pointCost: 1
  },
  {
    id: 'day-to-night',
    name: 'Architectural Day to Night',
    description: 'Transform bright daylight shots into atmospheric twilight scenes. Automatically detects windows and adds warm interior lighting.',
    icon: 'fa-moon',
    promptTemplate: 'Convert day to night. Add warm window glows and transform the sky into a deep twilight blue with subtle dusk gradients.',
    category: 'Style',
    apiProvider: 'gemini',
    previewOriginal: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&q=80&w=1000', 
    previewProcessed: 'https://images.unsplash.com/photo-1600607687940-467f4b638a14?auto=format&fit=crop&q=80&w=1000',
    pointCost: 1
  }
];

export const CREDIT_PLANS: CreditPlan[] = [
  { id: 'starter', amount: 10, price: 1.5, label: 'Starter Pack' },
  { id: 'pro', amount: 50, price: 7.5, label: 'Pro Creator' },
  { id: 'studio', amount: 200, price: 30.0, label: 'Studio License' }
];

export const STORAGE_KEYS = {
  USER: 'metrovan_user',
  TOOLS: 'metrovan_tools',
  SESSIONS: 'metrovan_sessions'
};
