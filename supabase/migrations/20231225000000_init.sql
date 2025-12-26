-- 1. 扩展与设置
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- 2. photo_tools 表
CREATE TABLE IF NOT EXISTS photo_tools (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    workflow_id TEXT NOT NULL,
    input_node_key TEXT NOT NULL DEFAULT 'input_image',
    point_cost INTEGER NOT NULL DEFAULT 1,
    preview_url TEXT,
    preview_original TEXT,
    preview_processed TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. jobs 表
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID NOT NULL, -- 对应 auth.users
    tool_id UUID REFERENCES photo_tools(id),
    project_name TEXT, -- 新增的项目名称/地址字段
    status TEXT NOT NULL DEFAULT 'pending', -- pending, queued, processing, completed, failed
    error_message TEXT,
    zip_key TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. job_assets 表
CREATE TABLE IF NOT EXISTS job_assets (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    r2_key TEXT NOT NULL,
    r2_output_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, uploaded, processed, failed
    runninghub_task_id TEXT,
    file_size BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. job_events 表
CREATE TABLE IF NOT EXISTS job_events (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    message TEXT,
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. profiles 表 (用于存储用户积分)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    points INTEGER DEFAULT 10, -- 初始赠送10积分
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. transactions 表 (积分流水)
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, -- 正数为充值，负数为消耗
    type TEXT NOT NULL, -- recharge, consume, refund
    description TEXT,
    job_id UUID REFERENCES jobs(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. 自动创建 profile 的触发器
-- 必须先删除旧的，防止冲突
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, points, is_admin)
  VALUES (new.id, new.email, 10, false)
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 9. RLS (Row Level Security)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;

-- 策略清理与重建 (防止重复策略报错)
DO $$ 
BEGIN
    DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can view own transactions" ON transactions;
    DROP POLICY IF EXISTS "Anyone can view active tools" ON photo_tools;
    DROP POLICY IF EXISTS "Users can view own jobs" ON jobs;
    DROP POLICY IF EXISTS "Users can insert own jobs" ON jobs;
    DROP POLICY IF EXISTS "Users can view own assets" ON job_assets;
    DROP POLICY IF EXISTS "Service role full access" ON profiles;
END $$;

CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can view own transactions" ON transactions FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Anyone can view active tools" ON photo_tools FOR SELECT USING (is_active = true);

CREATE POLICY "Users can view own jobs" ON jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own jobs" ON jobs FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own assets" ON job_assets FOR SELECT USING (
    EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_assets.job_id AND jobs.user_id = auth.uid())
);

-- 关键修复：允许服务角色完全访问 profiles，防止注册时的 500 错误
CREATE POLICY "Service role full access" ON profiles USING (true) WITH CHECK (true);

-- 种子数据 (使用 INSERT ON CONFLICT 避免重复报错)
INSERT INTO photo_tools (name, description, workflow_id, input_node_key, point_cost, preview_original, preview_processed)
VALUES 
('Real Estate Retouch', 'Professional AI photo optimization for property photography.', 'wf_raw_001', 'main_input', 1, '/previews/real-estate-before.jpg', '/previews/real-estate-after.jpg'),
('Architecture Day to Night', 'Transform architectural photos from daylight to stunning evening shots.', 'wf_upscale_001', 'image_input', 1, null, null)
ON CONFLICT DO NOTHING;
