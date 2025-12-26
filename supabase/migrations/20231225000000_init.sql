-- 1. 扩展与设置
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. photo_tools 表
CREATE TABLE photo_tools (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    workflow_id TEXT NOT NULL,
    input_node_key TEXT NOT NULL DEFAULT 'input_image',
    point_cost INTEGER NOT NULL DEFAULT 1,
    preview_url TEXT,
    preview_original TEXT,
    preview_processed TEXT,
>>>>>>> SEARCH
-- 种子数据
INSERT INTO photo_tools (name, description, workflow_id, input_node_key, point_cost, preview_url)
VALUES 
('Raw Retouch Pro', '专业级RAW格式照片优化，增强色彩与细节', 'wf_raw_001', 'main_input', 5, 'https://placehold.co/600x400?text=Raw+Retouch'),
('Batch AI Upscaler', '批量AI无损放大，提升分辨率', 'wf_upscale_001', 'image_input', 2, 'https://placehold.co/600x400?text=AI+Upscaler');
-- 种子数据
INSERT INTO photo_tools (name, description, workflow_id, input_node_key, point_cost, preview_original, preview_processed)
VALUES 
('Real Estate Retouch', 'Professional AI photo optimization for property photography.', 'wf_raw_001', 'main_input', 1, '/previews/real-estate-before.jpg', '/previews/real-estate-after.jpg'),
('Architecture Day to Night', 'Transform architectural photos from daylight to stunning evening shots.', 'wf_upscale_001', 'image_input', 1, null, null);
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. jobs 表
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE TABLE job_assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    r2_key TEXT NOT NULL,
    r2_output_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, uploaded, processed, failed
    runninghub_task_id TEXT,
    file_size BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. job_events 表
CREATE TABLE job_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    message TEXT,
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. profiles 表 (用于存储用户积分)
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    points INTEGER DEFAULT 10, -- 初始赠送10积分
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. transactions 表 (积分流水)
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, -- 正数为充值，负数为消耗
    type TEXT NOT NULL, -- recharge, consume, refund
    description TEXT,
    job_id UUID REFERENCES jobs(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. 自动创建 profile 的触发器
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, points)
  VALUES (new.id, new.email, 10);
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

CREATE POLICY "Users can view own profile" ON profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can view own transactions" ON transactions
    FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE photo_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;

-- 允许所有人查看 active 的 tools
CREATE POLICY "Anyone can view active tools" ON photo_tools
    FOR SELECT USING (is_active = true);

-- 用户只能看到自己的 jobs
CREATE POLICY "Users can view own jobs" ON jobs
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own jobs" ON jobs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 用户只能看到自己的 assets
CREATE POLICY "Users can view own assets" ON job_assets
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM jobs WHERE jobs.id = job_assets.job_id AND jobs.user_id = auth.uid()
        )
    );

-- Admin 策略 (假设使用 is_admin 声明，或者简单用 email 白名单)
-- 这里演示简单的白名单逻辑，实际建议用 Custom Claims
CREATE POLICY "Admin full access" ON photo_tools
    USING (auth.jwt() ->> 'email' LIKE '%@metrovan.ai'); -- 示例：公司邮箱为 admin

-- 种子数据
INSERT INTO photo_tools (name, description, workflow_id, input_node_key, point_cost, preview_url)
VALUES 
('Raw Retouch Pro', '专业级RAW格式照片优化，增强色彩与细节', 'wf_raw_001', 'main_input', 5, 'https://placehold.co/600x400?text=Raw+Retouch'),
('Batch AI Upscaler', '批量AI无损放大，提升分辨率', 'wf_upscale_001', 'image_input', 2, 'https://placehold.co/600x400?text=AI+Upscaler');
