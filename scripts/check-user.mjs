
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://ddehbmvuzbwfbscmmpfo.supabase.co';
const service_role_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZWhibXZ1emJ3ZmJzY21tcGZvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjcyMTEzOSwiZXhwIjoyMDgyMjk3MTM5fQ.jzVOhNWKO6yG_yAadnOsHJJM_bBzS4u04yTG1Pj6x_Y';

const supabase = createClient(supabaseUrl, service_role_key);

async function checkUser() {
  const email = 'zhoujin068@gmail.com';
  
  // 1. 尝试直接登录
  console.log(`Checking login for ${email}...`);
  const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
    email,
    password: '123456',
  });

  if (loginError) {
    console.error('Login failed with:', loginError.message);
    
    // 2. 如果登录失败，查询用户信息
    console.log('Querying user data via admin API...');
    const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
    
    const targetUser = users.find(u => u.email === email);
    if (targetUser) {
      console.log('User found in database:');
      console.log('- ID:', targetUser.id);
      console.log('- Email Confirmed:', !!targetUser.email_confirmed_at);
      console.log('- Last Sign In:', targetUser.last_sign_in_at);
      console.log('- Metadata:', targetUser.user_metadata);
    } else {
      console.log('User NOT found in database.');
    }
  } else {
    console.log('Login successful! Credentials are correct.');
  }
}

checkUser();
