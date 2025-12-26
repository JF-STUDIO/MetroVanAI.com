
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://ddehbmvuzbwfbscmmpfo.supabase.co';
const anon_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZWhibXZ1emJ3ZmJzY21tcGZvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjcyMTEzOSwiZXhwIjoyMDgyMjk3MTM5fQ.jzVOhNWKO6yG_yAadnOsHJJM_bBzS4u04yTG1Pj6x_Y';

const supabase = createClient(supabaseUrl, anon_key);

async function testAnonLogin() {
  const email = 'zhoujin068@gmail.com';
  const password = '123456';
  
  console.log(`Testing with provided Key...`);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error('FAILED:', error.message, error.status);
  } else {
    console.log('SUCCESS! Key is valid.');
  }
}

testAnonLogin();
