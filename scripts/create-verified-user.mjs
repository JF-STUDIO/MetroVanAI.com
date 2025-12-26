
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://ddehbmvuzbwfbscmmpfo.supabase.co';
const service_role_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZWhibXZ1emJ3ZmJzY21tcGZvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjcyMTEzOSwiZXhwIjoyMDgyMjk3MTM5fQ.jzVOhNWKO6yG_yAadnOsHJJM_bBzS4u04yTG1Pj6x_Y';

const supabase = createClient(supabaseUrl, service_role_key);

async function createVerifiedUser() {
  const email = 'final_verified_user@example.com';
  const password = 'Password123!';

  console.log(`Creating verified user: ${email}...`);

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // 关键：直接设置为已验证，跳过邮件发送
    user_metadata: { name: 'Final User' }
  });

  if (error) {
    console.error('Error creating user:', error.message);
  } else {
    console.log('✅ User created successfully!');
    console.log(`Email: ${email}`);
    console.log(`Password: ${password}`);
    console.log('You can now login directly with these credentials.');
  }
}

createVerifiedUser();
