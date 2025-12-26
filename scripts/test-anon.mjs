
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://ddehbmvuzbwfbscmmpfo.supabase.co';
const anon_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZWhibXZ1emJ3ZmJzY21tcGZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3MjExMzksImV4cCI6MjA4MjI5NzEzOX0.mcebFmuQVqs7DvPRiLhyuzfMIvwEQ47BEupev1SkGuk';

const supabase = createClient(supabaseUrl, anon_key);

async function testAnonLogin() {
  const email = 'zhoujin068@gmail.com';
  const password = '123456';
  
  console.log(`Testing front-end login simulation for ${email} using Anon Key...`);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error('Front-end simulation FAILED:', error.message);
  } else {
    console.log('Front-end simulation SUCCESSFUL! User session:', data.session ? 'Created' : 'Not found');
  }
}

testAnonLogin();
