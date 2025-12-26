import { createClient } from '@supabase/supabase-js';

// 注意：在生产环境中，这些值应该从环境变量中读取
// dotenv 已经在 index.ts 或 worker.ts 中加载
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase credentials missing in services/supabase.ts');
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
}) as any;
