import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Enterprise-grade logging for critical config failures
  console.error(
    '%cCRITICAL ERROR: Missing Supabase Configuration',
    'color: white; background-color: red; font-size: 16px; padding: 10px; border-radius: 4px;'
  );
  console.error('Please verify VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in your environment variables.');
  // In production, we might want to allow the app to crash or show a maintenance page
  // For now, we throw to stop partial initialization
  throw new Error('Critical: Missing Supabase environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
