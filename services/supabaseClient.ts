import { createClient } from '@supabase/supabase-js'

// 紧急硬编码以排除 Vercel 环境变量注入问题
const supabaseUrl = 'https://ddehbmvuzbwfbscmmpfo.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZWhibXZ1emJ3ZmJzY21tcGZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3MjExMzksImV4cCI6MjA4MjI5NzEzOX0.mcebFmuQVqs7DvPRiLhyuzfMIvwEQ47BEupev1SkGuk'

console.log('Using hardcoded Supabase configuration for production debug.')

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
