import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 运行时环境校验 (Critical Debugging)
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('FATAL ERROR: Supabase environment variables are missing!')
  console.log('VITE_SUPABASE_URL:', supabaseUrl)
  console.log('VITE_SUPABASE_ANON_KEY:', supabaseAnonKey ? 'Present' : 'Missing')
} else {
  console.log('Supabase Client Initialized')
  console.log('URL:', supabaseUrl)
  // 安全打印 Key 前 10 位，用于与 Vercel 后台对比
  console.log('Key Prefix:', supabaseAnonKey.substring(0, 10) + '...')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
