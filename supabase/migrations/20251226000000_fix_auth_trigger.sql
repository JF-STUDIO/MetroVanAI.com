-- 修复 Auth 触发器和 RLS 策略的迁移脚本

-- 1. 清理旧的触发器和函数
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- 2. 重建触发器函数 (增强健壮性)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, points, is_admin)
  VALUES (new.id, new.email, 10, false)
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. 重新绑定触发器
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 4. 修复 RLS 策略 (防止 500 错误的关键)
DO $$ 
BEGIN
    -- 先尝试删除可能存在的旧策略
    DROP POLICY IF EXISTS "Service role full access" ON public.profiles;
EXCEPTION
    WHEN undefined_object THEN NULL;
END $$;

-- 允许服务角色完全访问 profiles
CREATE POLICY "Service role full access" ON public.profiles
    AS PERMISSIVE
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 5. 确保 auth.users 可以读取自己的 profile
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT
    USING (auth.uid() = id);
