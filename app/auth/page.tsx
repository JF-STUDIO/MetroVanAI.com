'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function AuthPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [message, setMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    setSubmitting(true)

    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error

        // 注册成功后，尝试为该用户创建 profile 记录并写入用户名
        const userId = data.user?.id
        if (userId) {
          try {
            await supabase
              .from('profiles')
              .upsert(
                {
                  id: userId,
                  email,
                  display_name: username || null,
                  balance: 0,
                },
                { onConflict: 'id' },
              )
          } catch (e) {
            // 忽略 profile 写入失败，不影响注册流程
          }
        }

        setMessage('注册成功，请去邮箱查看确认邮件')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        router.push('/dashboard')
      }
    } catch (err: any) {
      setMessage(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white text-lg font-semibold">
            📷
          </div>
          <h1 className="text-xl font-semibold text-slate-900 mb-1">
            登录您的账户
          </h1>
          <p className="text-xs text-slate-500">
            或者{' '}
            <button
              type="button"
              onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
              className="text-blue-600 hover:underline"
            >
              {mode === 'login' ? '免费注册新账户' : '返回登录' }
            </button>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'signup' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                用户名
              </label>
              <input
                type="text"
                required
                placeholder="请输入用户名"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              电子邮箱地址
            </label>
            <input
              type="email"
              required
              placeholder="name@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              密码
            </label>
            <input
              type="password"
              required
              placeholder="请输入密码"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-blue-600 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting
              ? '处理中...'
              : mode === 'login'
              ? '立即登录'
              : '创建账户'}
          </button>
        </form>

        {message && (
          <p className="mt-3 text-xs text-red-500 text-center">{message}</p>
        )}

        <p className="mt-6 text-center text-[11px] text-slate-400">
          演示模式：任意邮箱地址和密码即可登录。
        </p>
      </div>
    </div>
  )
}
