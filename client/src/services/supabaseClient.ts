import { createClient } from '@supabase/supabase-js'

// Hardcoded for production stability - Anon key is safe to expose
const supabaseUrl = 'https://ulctdvytpigqywmfqygf.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsY3Rkdnl0cGlncXl3bWZxeWdmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3OTA0NjgsImV4cCI6MjA4MjM2NjQ2OH0.adhpgdzSFbggMLWPJ0lbJfFsa6l0vzzBB3Iyo2qQQ-I'

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
