'use client'

import Image from 'next/image'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function Home() {
  const router = useRouter()
  const [checkingUser, setCheckingUser] = useState(true)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const [lang, setLang] = useState<'en' | 'zh'>('en')

  // 对比滑块状态
  const [sliderPercent, setSliderPercent] = useState(50)
  const [isDragging, setIsDragging] = useState(false)
  const compareRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    async function checkUser() {
      const { data } = await supabase.auth.getUser()
      setIsLoggedIn(!!data.user)
      setCheckingUser(false)
    }
    checkUser()
  }, [])

  function handleEditClick() {
    if (checkingUser) return
    if (isLoggedIn) {
      router.push('/dashboard')
    } else {
      setShowWelcome(true)
    }
  }

  function handleStartFree() {
    router.push('/auth')
  }

  function handleRegister() {
    router.push('/auth?mode=signup')
  }

  const heroTitle1 =
    lang === 'en' ? 'Turn everyday listing photos into eye‑catching hero shots' : '只需一张正常曝光照片'
  const heroTitle2 =
    lang === 'en' ? 'MetroVan AI for real estate photos in Metro Vancouver' : '即可获得完美房产大片'
  const heroSub =
    lang === 'en'
      ? 'MetroVan AI automatically balances exposure, fixes skies, and cleans up rooms for Metro Vancouver real estate agents.'
      : 'MetroVan AI 自动处理光影、蓝天和室内杂物。上传照片，一键增强，无需专业摄影技巧。'

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* 顶部导航 */}
      <header className="border-b border-slate-100 bg-white/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-white text-sm font-semibold">
              M
            </div>
            <span className="text-sm font-semibold text-slate-900">MetroVan AI</span>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-slate-600 md:flex">
            <button className="text-slate-900 font-medium">
              {lang === 'en' ? 'Home' : '首页'}
            </button>
            <button className="hover:text-slate-900" onClick={handleEditClick}>
              {lang === 'en' ? 'AI Studio' : 'AI工作室'}
            </button>
            <button
              className="hover:text-slate-900"
              onClick={() => router.push('/pricing')}
            >
              {lang === 'en            <button
              className="rounded-full px-3 py-1 text-slate-600 hover:bg-slate-50"
              onClick={() => router.push('/auth')}
            >
              {lang === 'en' ? 'Sign in' : '登录'}
            </button>
            <button
              className="rounded-full bg-blue-600 px-4 py-1.5 text-white shadow-sm hover:bg-blue-700"
              onClick={handleRegister}
            >
              {lang === 'en' ? 'Sign up for free' : '免费注册'}
            </button>
          </div>
        </div>
      </header>

      {/* Hero 区域 */}
      <main className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-16 pb-20 text-center">
        {/* 顶部提示条 */}
        <p className="inline-flex items-center rounded-full bg-blue-50 px-4 py-1 text-xs font-medium text-blue-700">
          免费体验 3 张 · 注册再送 5 张
        </p>

        {/* 主标题两行，第二行渐变色 */}
        <div className="mt-6 space-y-3">
          <h1 className="text-4xl font-bold leading-snug text-slate-900 md:text-5xl">
            {heroTitle1}
          </h1>
          <h2 className="bg-gradient-to-r from-[#2551ff] via-[#574bff] to-[#8b5cf6] bg-clip-text text-4xl font-bold leading-snug text-transparent md:text-5xl">
            {heroTitle2}
          </h2>
        </div>

        {/* 副标题文案 */}
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-slate-600">
          {heroSub}
        </p>

        {/* 按钮区域：居中排布 */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4 text-sm">
          <button
            onClick={handleEditClick}
            className="inline-flex items-center justify-center rounded-full bg-[#2551ff] px-7 py-2.5 font-medium text-white shadow-sm shadow-[#2551ff]/40 hover:bg-[#1f45e0] hover:shadow-md transition-all"
          >
            {lang === 'en' ? 'Start free trial' : '立即免费试用'}
          </button>
          <button
            onClick={() => router.push('/pricing')}
            className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-7 py-2.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            {lang === 'en' ? 'View pricing' : '查看价格方案'}
          </button>
        </div>
      </main>

      {/* 功能优势区域 */}
      <section className="border-t border-slate-100 bg-slate-50/60">
        <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-center text-2xl font-semibold text-slate-900">
              {lang === 'en' ? 'Why choose MetroVan AI?' : '为什么选择 MetroVan AI?'}
            </h2>
            <p className="mt-3 text-center text-sm text-slate-600">
              {lang === 'en'
                ? 'A dedicated AI workflow for real estate agents and photographers in Metro Vancouver.'
                : '专为房地产经纪人和摄影师打造的一站式 AI 修图工作流。'}
            </p>

          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {/* 卡片 1 */}
            <div className="flex flex-col justify-between rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
              <div>
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-500 mb-4">
                  ✏️
                </div>
                <h3 className="text-sm font-semibold text-slate-900 mb-2">
                  {lang === 'en' ? 'Real estate photo enhancement' : '房地产修图'}
                </h3>
                <p className="text-xs leading-relaxed text-slate-600">
                  {lang === 'en'
                    ? 'Even phone photos can be automatically balanced, brightened, and made listing-ready with natural window views.'
                    : '普通手机照片也能一键平衡曝光、提亮阴影，还原窗外景色，营造专业大片质感。'}
                </p>
              </div>
            </div>

            {/* 卡片 2 */}
            <div className="flex flex-col justify-between rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
              <div>
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-500 mb-4">
                  📷
                </div>
                <h3 className="text-sm font-semibold text-slate-900 mb-2">
                  {lang === 'en' ? 'One-click sky replacement' : '一键蓝天置换'}
                </h3>
                <p className="text-xs leading-relaxed text-slate-600">
                  {lang === 'en'
                    ? 'Turn grey skies into clear blue instantly. AI detects sky regions and swaps in bright, appealing skies.'
                    : '阴天秒变晴天，AI 自动识别天空区域并替换为通透蓝天白云，显著提升外立面吸引力。'}
                </p>
              </div>
            </div>

            {/* 卡片 3 */}
            <div className="flex flex-col justify-between rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
              <div>
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-500 mb-4">
                  ⚡
                </div>
                <h3 className="text-sm font-semibold text-slate-900 mb-2">
                  {lang === 'en' ? 'Fast turnaround' : '极速交付'}
                </h3>
                <p className="text-xs leading-relaxed text-slate-600">
                  {lang === 'en'
                    ? 'Skip the manual editing queue. Generate polished sets in seconds and get listings online faster.'
                    : '无需等待人工修图，几秒内即可批量生成成片，帮助你更快上架房源。'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 效果对比区域 */}
      <section className="border-t border-slate-100 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 md:flex-row md:items-center">
          {/* 左侧文案 */}
          <div className="md:w-2/5 space-y-4">
            <h2 className="text-2xl font-semibold text-slate-900">
              {lang === 'en' ? 'Before/after comparison' : '效果对比演示'}
            </h2>
            <ul className="space-y-2 text-sm text-slate-700">
              <li>· 昏暗光线自动修复</li>
              <li>· 杂乱物品智能移除</li>
              <li>· 垂直线条自动校正</li>
              <li>· 色彩氛围自动优化</li>
            </ul>
            <button
              onClick={handleEditClick}
              className="mt-4 inline-flex items-center text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              亲身体验效果 →
            </button>
          </div>

          {/* 右侧 Before / After 图片对比（可拖动滑块） */}
          <div className="md:w-3/5">
            <div
              ref={compareRef}
              className="relative overflow-hidden rounded-3xl bg-slate-100 shadow-inner border border-slate-200 flex items-stretch justify-center px-6 py-5 select-none"
              onMouseMove={(e) => {
                if (!isDragging || !compareRef.current) return
                const rect = compareRef.current.getBoundingClientRect()
                const x = e.clientX - rect.left
                const percent = Math.min(100, Math.max(0, (x / rect.width) * 100))
                setSliderPercent(percent)
              }}
              onMouseLeave={() => setIsDragging(false)}
              onMouseUp={() => setIsDragging(false)}
              onTouchMove={(e) => {
                if (!compareRef.current) return
                const touch = e.touches[0]
                if (!touch) return
                const rect = compareRef.current.getBoundingClientRect()
                const x = touch.clientX - rect.left
                const percent = Math.min(100, Math.max(0, (x / rect.width) * 100))
                setSliderPercent(percent)
              }}
              onTouchEnd={() => setIsDragging(false)}
            >
              {/* 左侧标签 */}
              <div className="absolute inset-y-5 left-6 flex flex-col justify-between text-xs text-slate-500 z-20">
                <span>Original</span>
                <span className="mt-auto">AI Enhanced</span>
              </div>

              {/* 底层：AI 后照片全宽 */}
              <div className="relative w-full max-w-xl rounded-2xl overflow-hidden bg-slate-200">
                <div className="relative h-48 md:h-56">
                  <Image
                    src="/demo-after.jpg"
                    alt="AI 优化后照片"
                    fill
                    className="object-cover"
                  />
                </div>

                {/* 上层：原始照片，根据滑块百分比裁剪，只显示左侧 */}
                <div
                  className="pointer-events-none absolute inset-0 left-0 overflow-hidden border-r border-white/70"
                  style={{ clipPath: `polygon(0 0, ${sliderPercent}% 0, ${sliderPercent}% 100%, 0 100%)` }}
                >
                  <div className="relative h-48 md:h-56">
                    <Image
                      src="/demo-before.jpg"
                      alt="室内原始照片"
                      fill
                      className="object-cover"
                    />
                  </div>
                </div>

                {/* 中间滑块线 + 把手 */}
                <div
                  className="absolute inset-y-2 flex items-center justify-center"
                  style={{ left: `${sliderPercent}%`, transform: 'translateX(-50%)' }}
                >
                  <div className="h-full w-[2px] bg-white shadow-sm" />
                  <button
                    type="button"
                    className="relative z-30 -ml-[10px] flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-md border border-slate-200 cursor-col-resize"
                    onMouseDown={() => setIsDragging(true)}
                    onTouchStart={(e) => {
                      e.preventDefault()
                      setIsDragging(true)
                    }}
                  >
                    <span className="h-3 w-3 rounded-full bg-slate-300" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 未登录时的欢迎弹窗 */}
      {showWelcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl">
            <div className="h-24 rounded-t-2xl bg-gradient-to-r from-[#6366F1] to-[#EC4899]" />
            <button
              className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full bg-black/20 text-white text-sm"
              onClick={() => setShowWelcome(false)}
              aria-label="关闭"
            >
              ×
            </button>

            <div className="-mt-10 px-8 pb-8 pt-4 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-md">
                <span className="text-xl">✨</span>
              </div>
              <h2 className="mb-2 text-lg font-semibold text-slate-900">
                欢迎体验 MetroVan AI
              </h2>
              <p className="mb-1 text-xs text-blue-600 font-medium">
                3 张免费修图额度已发放！
              </p>
              <p className="mb-5 text-xs leading-relaxed text-slate-600">
                只需上传一张照片，AI 自动帮您完成专业级修图。
              </p>

              <button
                onClick={handleStartFree}
                className="mb-3 inline-flex w-full items-center justify-center rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              >
                立即免费试用
              </button>
              <button
                onClick={handleRegister}
                className="inline-flex w-full items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                注册并保存作品
              </button>
              <p className="mt-3 text-[11px] text-slate-400">
                无需注册也可直接开始体验
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
