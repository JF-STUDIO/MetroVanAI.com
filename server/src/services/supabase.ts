import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseInstance: SupabaseClient | null = null;

export const getSupabaseAdmin = () => {
  if (supabaseInstance) return supabaseInstance;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(`CRITICAL: Missing Supabase credentials. URL: ${!!supabaseUrl}, KEY: ${!!supabaseServiceKey}`);
  }

  supabaseInstance = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return supabaseInstance;
};

// Main export proxy to keep compatibility with existing code imports
// Main export proxy to keep compatibility with existing code imports
// We use a Proxy to enforce lazy initialization
export const supabaseAdmin = new Proxy({} as any, {
  get: (_target, prop) => {
    const instance = getSupabaseAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (instance as any)[prop];
  }
}) as SupabaseClient;
