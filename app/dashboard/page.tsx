'use client'

import { useEffect, useState, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

type Project = {
  id: string
  name: string
  created_at: string
}

type Job = {
  id: string
  input_path: string
  status: 'uploaded' | 'processing' | 'done' | 'failed' | string
  created_at: string
  updated_at?: string | null
  output_path?: string | null
  project_id?: string | null
  error_message?: string | null
}

function getProjectRemainingAndEta(projectId: string, jobs: Job[]) {
  const projectJobs = jobs.filter(j => j.project_id === projectId)
  const remaining = projectJobs.filter(j => j.status !== 'done').length

  const finished = projectJobs.filter(j => j.status === 'done')
  const durations = finished
    .map(j => {
      const start = new Date(j.created_at).getTime()
      const end = new Date(j.updated_at ?? j.created_at).getTime()
      return Math.max(0, (end - start) / 1000)
    })
    .filter(d => d > 0)

  const defaultSecondsPerJob = 60 // 没有历史数据时，先按 1 分钟/张 估算
  const avgSecondsPerJob =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : defaultSecondsPerJob

  const etaMinutes = Math.ceil((remaining * avgSecondsPerJob) / 60)

  return { remaining, etaMinutes }
}

type PendingFile = {
  id: string
  file: File
  checked: boolean
}

export default function DashboardPage() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [jobs, setJobs] = useState<Job[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [openedProjectId, setOpenedProjectId] = useState<string | null>(null)
  const [newProjectName, setNewProjectName] = useState('')
  const [balance, setBalance] = useState<number | null>(null)
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([])
  const [activeTool, setActiveTool] = useState<'estate' | 'sky' | 'clutter' | 'custom'>('estate')
  const [activeMarketingTool, setActiveMarketingTool] = useState<'none' | 'listing' | 'pdf' | 'video'>('none')
  const [listingAddress, setListingAddress] = useState('')
  const [listingHighlights, setListingHighlights] = useState('')
  const [listingText, setListingText] = useState('')
  const [listingLoading, setListingLoading] = useState(false)

  // 简单购买额度弹窗状态（占位 UI，后续接 Stripe / PayPal）
  const [showBilling, setShowBilling] = useState(false)
  const [paygQuantity, setPaygQuantity] = useState<number>(10)
  const [billingLoading, setBillingLoading] = useState(false)

  // === 上传进度（项目内批量上传） ===
  const [projectUploadTotal, setProjectUploadTotal] = useState(0)
  const [projectUploadDone, setProjectUploadDone] = useState(0)
  const [projectUploading, setProjectUploading] = useState(false)

  // === 下载辅助函数 ===
  function triggerDownload(url: string, filename?: string) {
    const a = document.createElement('a')
    a.href = url
    if (filename) a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function getDownloadFilename(job: Job): string {
    // 优先用 output_path 里的文件名
    if (job.output_path) {
      const last = job.output_path.split('/').pop()
      if (last) return last
    }
    // 兜底用 input_path 最后的文件名
    const inputLast = job.input_path.split('/').pop()
    return inputLast || 'download.jpg'
  }

  useEffect(() => {
    async function loadUserProjectsAndJobs() {
      const { data, error } = await supabase.auth.getUser()
      if (error || !data.user) {
        router.push('/auth')
        return
      }

      const user = data.user
      setEmail(user.email ?? null)
      setUserId(user.id)

      // 读取 profiles 中的余额；如果查询失败或没有记录，则视为 0
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('balance')
          .eq('id', user.id)
          .single()

        const currentBalance = (profile as { balance?: number } | null)?.balance ?? 0
        setBalance(currentBalance)
      } catch (e) {
        // 查询失败时，保持现有 balance，不影响页面其它功能
      }

      // 加载项目列表（房源地址）
      const { data: projectsData, error: projectsError } = await supabase
        .from('projects')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })

      if (!projectsError && projectsData) {
        setProjects(projectsData as Project[])
        if (projectsData.length > 0) {
          setSelectedProjectId(projectsData[0].id)
        }
      }

      // 加载当前用户的所有任务（前端再按项目过滤）
      const { data: jobsData, error: jobsError } = await supabase
        .from('jobs')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })

      if (!jobsError && jobsData) {
        setJobs(jobsData as Job[])
      }

      setLoading(false)
    }

    loadUserProjectsAndJobs()
  }, [router])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/auth')
  }

  async function startStripeCheckout(plan: 'payg' | 'pro_500' | 'team_1000', quantity: number = 1) {
    if (!userId) {
      alert('用户未登录')
      return
    }

    try {
      setBillingLoading(true)
      const res = await fetch('/api/checkout/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, quantity, userId }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert('创建支付会话失败：' + (data.error ?? res.statusText))
        return
      }

      const data = (await res.json()) as { url?: string }
      if (data.url) {
        window.location.href = data.url
      } else {
        alert('未获取到支付链接，请稍后重试。')
      }
    } catch (e: any) {
      console.error(e)
      alert('发起支付时发生错误：' + e.message)
    } finally {
      setBillingLoading(false)
    }
  }

  async function handleCreateProject() {
    if (!userId) {
      alert('用户未登录')
      return
    }
    const name = newProjectName.trim()
    if (!name) {
      alert('请先输入项目名称（例如：某某小区 1203）')
      return
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({ user_id: userId, name })
      .select()
      .single()

    if (error || !data) {
      alert('创建项目失败：' + (error?.message ?? '未知错误'))
      return
    }

    const project = data as Project
    setProjects(prev => [project, ...prev])
    setSelectedProjectId(project.id)
    setNewProjectName('')
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">加载中...</div>
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    const withIds: PendingFile[] = files.map(file => ({
      id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2)}`,
      file,
      checked: true,
    }))

    setPendingFiles(prev => [...prev, ...withIds])
    e.target.value = ''
  }

  async function handleUploadSelected() {
    if (!userId) {
      alert('用户未登录')
      return
    }

    if (!selectedProjectId) {
      alert('请先创建并选择一个项目（房源地址）再上传照片')
      return
    }

    const filesToUpload = pendingFiles.filter(p => p.checked)
    if (filesToUpload.length === 0) {
      alert('请先勾选要上传的照片')
      return
    }

    // 查询最新余额，确保有足够额度
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('balance')
        .eq('id', userId)
        .single()

      // 即使查询失败，也不会阻止后续逻辑，默认为 0 余额

      const currentBalance = (profile as { balance?: number } | null)?.balance ?? 0
      if (currentBalance <= 0) {
        alert('余额不足，请联系管理员充值后再上传。')
        return
      }

      if (currentBalance < filesToUpload.length) {
        if (
          !window.confirm(
            `当前余额为 ${currentBalance}，本次选择了 ${filesToUpload.length} 张照片。\n系统将按最多 ${currentBalance} 张创建任务，超出的将被忽略，是否继续？`,
          )
        ) {
          return
        }
      }
    } catch (e) {
      console.error('检查余额时出错:', e)
    }

    setProjectUploadTotal(filesToUpload.length)
    setProjectUploadDone(0)
    setProjectUploading(true)

    try {
      const newJobs: Job[] = []

      const selectedProject = projects.find(p => p.id === selectedProjectId)
      const projectFolderRaw = selectedProject?.name || selectedProjectId
      const projectFolder = projectFolderRaw
        .normalize('NFKD')
        .replace(/[^\w.-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || 'project'

      // 房地产修图：存储路径使用 ASCII 目录名，避免 Supabase Storage "Invalid key" 错误
      // 映射关系：房地产修图 -> real-estate
      const estateRootFolder = 'real-estate'

      for (const item of filesToUpload) {
        const file = item.file
        const timestamp = Date.now()
        const original = file.name
        const safeName =
          original
            .normalize('NFKD')
            .replace(/[^\w.-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '') || `file_${timestamp}.jpg`

        const path = `user/${userId}/${estateRootFolder}/${projectFolder}/${timestamp}-${safeName}`

        const { error: uploadError } = await supabase.storage
          .from('images')
          .upload(path, file)

        if (uploadError) {
          console.error(uploadError)
          alert(`上传失败（${file.name}）：` + uploadError.message)
          continue
        }

        const { data: inserted, error: insertError } = await supabase
          .from('jobs')
          .insert({
            user_id: userId,
            input_path: path,
            status: 'uploaded',
            project_id: selectedProjectId,
          })
          .select()
          .single()

        if (insertError || !inserted) {
          console.error(insertError)
          alert(`创建任务失败（${file.name}）：` + (insertError?.message ?? '未知错误'))
          continue
        }

        newJobs.push(inserted as Job)
        setProjectUploadDone(prev => prev + 1)
      }

      if (newJobs.length > 0) {
        setJobs(prev => [...newJobs, ...prev])
        setPendingFiles(prev =>
          prev.filter(p => !filesToUpload.some(f => f.id === p.id)),
        )
        // 成功时不再弹出浏览器 alert，只用进度条表示
      }
    } catch (err: any) {
      console.error(err)
      alert('发生错误：' + err.message)
    } finally {
      setProjectUploading(false)
      setProjectUploadTotal(0)
      setProjectUploadDone(0)
    }
  }

  async function handleSimpleUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!userId || files.length === 0) {
      e.target.value = ''
      return
    }

    // 只允许 JPG/JPEG 和常见相机 RAW，禁止 PNG
    const allowedExts = ['.jpg', '.jpeg', '.cr2', '.cr3', '.arw', '.nef', '.nrw', '.dng', '.raf', '.orf', '.rw2', '.srw']
    const invalidFiles = files.filter(f => {
      const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase()
      return !allowedExts.includes(ext)
    })

    if (invalidFiles.length > 0) {
      alert(
        '目前仅支持上传 JPG/JPEG 和常见相机 RAW 格式（ARW/CR2/NEF/DNG 等），不支持 PNG 或其它格式。' +
          '\n以下文件将不会被上传：\n' +
          invalidFiles.map(f => '- ' + f.name).join('\n'),
      )
      e.target.value = ''
      return
    }
 ''
      return
    }

    // 只允许 JPG/JPEG 和常见相机 RAW，禁止 PNG
    const allowedExts = ['.jpg', '.jpeg', '.cr2', '.cr3', '.arw', '.nef', '.nrw', '.dng', '.raf', '.orf', '.rw2', '.srw']
    const invalidFiles = files.filter(f => {
      const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase()
      return !allowedExts.includes(ext)
    })

    if (invalidFiles.length > 0) {
      alert(
        '目前仅支持上传 JPG/JPEG 和常见相机 RAW 格式（ARW/CR2/NEF/DNG 等），不支持 PNG 或其它格式。' +
          '\n以下文件将不会被上传：\n' +
          invalidFiles.map(f => '- ' + f.name).join('\n'),
      )
      e.target.value = ''
      return
    }

    // 查询最新余额，确保有足够额度
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('balance')
        .eq('id', userId)
        .single()

      // 即使查询失败，也不会阻止后续逻辑，默认为 0 余额

      const currentBalance = (profile as { balance?: number } | null)?.balance ?? 0
      if (currentBalance <= 0) {
        alert('余额不足，请联系管理员充值后再上传。')
        e.target.value = ''
        return
      }

      if (currentBalance < files.length) {
        if (
          !window.confirm(
            `当前余额为 ${currentBalance}，本次选择了 ${files.length} 张照片。\n系统将按最多 ${currentBalance} 张创建任务，超出的将被忽略，是否继续？`,
          )
        ) {
          e.target.value = ''
          return
        }
      }
    } catch (e) {
      console.error('检查余额时出错:', e)
    }

    // 更换天空 / 智能去杂物 / 待开发：存储路径使用 ASCII 目录名，避免 Supabase Storage "Invalid key" 错误
    // 映射关系：更换天空 -> replace-sky，智能去杂物 -> remove-clutter，待开发 -> custom
    const toolFolder =
      activeTool === 'sky'
        ? 'replace-sky'
        : activeTool === 'clutter'
        ? 'remove-clutter'
        : 'custom'

    try {
      const newJobs: Job[] = []

      for (const file of files) {
        const timestamp = Date.now()
        const original = file.name
        const safeName =
          original
            .normalize('NFKD')
            .replace(/[^\w.-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '') || `file_${timestamp}.jpg`

        const path = `user/${userId}/${toolFolder}/${timestamp}-${safeName}`

        const { error: uploadError } = await supabase.storage
          .from('images')
          .upload(path, file)

        if (uploadError) {
          console.error(uploadError)
          alert(`上传失败（${file.name}）：` + uploadError.message)
          continue
        }

        const { data: inserted, error: insertError } = await supabase
          .from('jobs')
          .insert({
            user_id: userId,
            input_path: path,
            status: 'uploaded',
            project_id: null,
          })
          .select()
          .single()

        if (insertError || !inserted) {
          console.error(insertError)
          alert(`创建任务失败（${file.name}）：` + (insertError?.message ?? '未知错误'))
          continue
        }

        newJobs.push(inserted as Job)
      }

      if (newJobs.length > 0) {
        setJobs(prev => [...newJobs, ...prev])
        // 简单上传成功时也不再弹出 alert
      }
    } catch (err: any) {
      console.error(err)
      alert('发生错误：' + err.message)
    } finally {
      e.target.value = ''
    }
  }

  async function handleDownloadAll() {
    const projectJobs =
      activeTool === 'estate'
        ? selectedProjectId
          ? jobs.filter(
              j => j.project_id === selectedProjectId && j.status === 'done' && j.output_path,
            )
          : jobs.filter(j => j.status === 'done' && j.output_path)
        : jobs.filter(j => j.status === 'done' && j.output_path)

    if (projectJobs.length === 0) {
      alert('当前项目暂时没有已完成的图片')
      return
    }

    for (const job of projectJobs) {
      const filename = getDownloadFilename(job)
      const { data, error } = await supabase.storage
        .from('images')
        .createSignedUrl(job.output_path!, 60, { download: filename })

      if (error || !data?.signedUrl) {
        console.error(error)
        alert('生成下载链接失败：' + (error?.message ?? '未知错误'))
        continue
      }

      triggerDownload(data.signedUrl, filename)
    }
  }

  async function handleDownloadProjectAll(projectId: string) {
    const projectJobs = jobs.filter(
      j => j.project_id === projectId && j.status === 'done' && j.output_path,
    )

    if (projectJobs.length === 0) {
      alert('该项目暂时没有已完成的图片')
      return
    }

    for (const job of projectJobs) {
      const filename = getDownloadFilename(job)
      const { data, error } = await supabase.storage
        .from('images')
        .createSignedUrl(job.output_path!, 60, { download: filename })

      if (error || !data?.signedUrl) {
        console.error(error)
        alert('生成下载链接失败：' + (error?.message ?? '未知错误'))
        continue
      }

      triggerDownload(data.signedUrl, filename)
    }
  }

  function toggleJobSelection(jobId: string, checked: boolean) {
    setSelectedJobIds(prev => {
      if (checked) {
        if (prev.includes(jobId)) return prev
        return [...prev, jobId]
      }
      return prev.filter(id => id !== jobId)
    })
  }

  async function handleDeleteSelectedJobs() {
    if (selectedJobIds.length === 0) {
      alert('请先勾选要删除的任务')
      return
    }

    const jobsToDelete = jobs.filter(j => selectedJobIds.includes(j.id))
    const pathsToRemove = [
      ...jobsToDelete.map(j => j.input_path),
      ...jobsToDelete
        .map(j => j.output_path)
        .filter((p): p is string => !!p),
    ]

    try {
      if (pathsToRemove.length > 0) {
        const { error: removeError } = await supabase.storage
          .from('images')
          .remove(pathsToRemove)

        if (removeError) {
          console.error(removeError)
          alert('删除存储文件失败：' + removeError.message)
          return
        }
      }

      const { error: deleteError } = await supabase
        .from('jobs')
        .delete()
        .in('id', selectedJobIds)

      if (deleteError) {
        console.error(deleteError)
        alert('删除任务失败：' + deleteError.message)
        return
      }

      setJobs(prev => prev.filter(j => !selectedJobIds.includes(j.id)))
      setSelectedJobIds([])
      alert('已删除选中任务及其存储文件')
    } catch (err: any) {
      console.error(err)
      alert('删除时发生错误：' + err.message)
    }
  }

  async function handleDeleteProject(projectId: string) {
    const project = projects.find(p => p.id === projectId)
    const projectName = project?.name ?? '该项目'

    if (!window.confirm(`确定要删除项目 “${projectName}” 吗？\n此操作会同时删除该项目下的所有任务及图片，且无法恢复。`)) {
      return
    }

    const projectJobs = jobs.filter(j => j.project_id === projectId)
    const pathsToRemove = [
      ...projectJobs.map(j => j.input_path),
      ...projectJobs
        .map(j => j.output_path)
        .filter((p): p is string => !!p),
    ]

    try {
      if (pathsToRemove.length > 0) {
        const { error: removeError } = await supabase.storage
          .from('images')
          .remove(pathsToRemove)

        if (removeError) {
          console.error(removeError)
          alert('删除项目图片失败：' + removeError.message)
          return
        }
      }

      const { error: deleteJobsError } = await supabase
        .from('jobs')
        .delete()
        .eq('project_id', projectId)

      if (deleteJobsError) {
        console.error(deleteJobsError)
        alert('删除项目下任务失败：' + deleteJobsError.message)
        return
      }

      const { error: deleteProjectError } = await supabase
        .from('projects')
        .delete()
        .eq('id', projectId)

      if (deleteProjectError) {
        console.error(deleteProjectError)
        alert('删除项目失败：' + deleteProjectError.message)
        return
      }

      const updatedProjects = projects.filter(p => p.id !== projectId)
      setProjects(updatedProjects)
      setJobs(prev => prev.filter(j => j.project_id !== projectId))

      if (selectedProjectId === projectId) {
        setSelectedProjectId(updatedProjects[0]?.id ?? null)
      }
      if (openedProjectId === projectId) {
        setOpenedProjectId(null)
      }

      alert('项目及其关联任务已删除')
    } catch (err: any) {
      console.error(err)
      alert('删除项目时发生错误：' + err.message)
    }
  }

  // 天空替换 / 去杂物 当前工具对应的任务（根据存储路径里的目录判断）
  const toolJobs =
    activeTool === 'sky' || activeTool === 'clutter'
      ? jobs.filter(job =>
          job.input_path.includes(
            activeTool === 'sky' ? '/replace-sky/' : '/remove-clutter/',
          ),
        )
      : []

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      {/* 简单购买额度弹窗，占位 UI */}
      {showBilling && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-5xl rounded-2xl bg-slate-950 border border-slate-700 p-6 text-xs shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-50">简单的定价，按需购买</div>
                <div className="mt-1 text-[11px] text-slate-400">
                  点数永久有效，随时使用。1 点 = 1 张精修图。当前余额：{balance ?? 0} 点
                </div>
              </div>
              <button
                onClick={() => setShowBilling(false)}
                className="text-slate-400 hover:text-slate-100 text-xs"
              >
                关闭
              </button>
            </div>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
              {/* 按需充值 */}
              <div className="rounded-2xl border border-slate-700 bg-slate-900/60 p-5 flex flex-col">
                <div className="text-sm font-semibold text-slate-100 mb-1">按需充值</div>
                <div className="text-[11px] text-slate-400 mb-4">适合偶尔使用的用户，灵活自由。</div>
                <div className="mb-4 text-2xl font-semibold text-slate-50">
                  $0.30 <span className="text-xs text-slate-400">/ 点</span>
                </div>
                <label className="mb-2 text-[11px] font-medium text-slate-300">输入购买数量（至少 2 点）</label>
                <input
                  type="number"
                  min={2}
                  value={paygQuantity}
                  onChange={e => setPaygQuantity(Math.max(2, Number(e.target.value) || 2))}
                  className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <div className="mb-4 text-[11px] text-slate-300">
                  总计金额 <span className="font-semibold">${(paygQuantity * 0.3).toFixed(2)}</span>（约 ${(0.3).toFixed(2)} / 点）
                </div>
                <button
                  disabled={billingLoading}
                  onClick={() => startStripeCheckout('payg', paygQuantity)}
                  className="mt-auto w-full rounded-full bg-slate-800 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-70"
                >
                  {billingLoading ? '正在跳转支付...' : '立即充值'}
                </button>
              </div>

              {/* 专业包 500 点 */}
              <div className="rounded-2xl border border-emerald-500 bg-slate-900/80 p-5 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold text-slate-100">专业包</div>
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">热销推荐</span>
                </div>
                <div className="text-[11px] text-slate-400 mb-4">适合独立经纪人和摄影师。</div>
                <div className="mb-1 text-2xl font-semibold text-slate-50">$125</div>
                <div className="mb-3 text-[11px] text-slate-400">/ 500 点</div>
                <div className="mb-4 text-[11px] text-emerald-300">单价约 $0.25 / 点（整包 500 点 = $125，省 17%）</div>
                <ul className="mb-4 space-y-1 text-[11px] text-slate-300 list-disc list-inside">
                  <li>含约 500 张修图额度</li>
                  <li>优先处理通道</li>
                  <li>点数永久不过期</li>
                </ul>
                <button
                  disabled={billingLoading}
                  onClick={() => startStripeCheckout('pro_500', 1)}
                  className="mt-auto w-full rounded-full bg-blue-600 py-2 text-xs font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-70"
                >
                  {billingLoading ? '正在跳转支付...' : '购买 500 点数'}
                </button>
              </div>

              {/* 机构包 1000 点 */}
              <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5 flex flex-col">
                <div className="text-sm font-semibold text-slate-100 mb-2">机构包</div>
                <div className="text-[11px] text-slate-400 mb-4">适合大量图像的团队和机构。</div>
                <div className="mb-1 text-2xl font-semibold text-slate-50">$200</div>
                <div className="mb-3 text-[11px] text-slate-400">/ 1000 点</div>
                <div className="mb-4 text-[11px] text-emerald-300">单价约 $0.20 / 点（整包 1000 点 = $200，省 33%）</div>
                <ul className="mb-4 space-y-1 text-[11px] text-slate-300 list-disc list-inside">
                  <li>含约 1000 张修图额度</li>
                  <li>精确并发处理</li>
                  <li>专属客户经理支持（后续提供）</li>
                </ul>
                <button
                  disabled={billingLoading}
                  onClick={() => startStripeCheckout('team_1000', 1)}
                  className="mt-auto w-full rounded-full bg-slate-800 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-70"
                >
                  {billingLoading ? '正在跳转支付...' : '购买 1000 点数'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 顶部蓝条导航 */}
      <header className="border-b border-slate-800 bg-slate-950/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          {/* 左侧：点击 Logo 可返回首页 */}
          <button
            type="button"
            onClick={() => router.push('/')}
            className="flex items-center gap-2 text-left focus:outline-none"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500 text-white text-sm font-semibold">
              M
            </div>
            <div className="flex flex-col text-xs leading-tight">
              <span className="font-semibold text-slate-50">MetroVan AI</span>
              <span className="text-slate-400">AI 工作室</span>
              {balance !== null && (
                <span className="text-slate-300">余额：{balance}</span>
              )}
            </div>
          </button>

          {/* 右侧：新增“返回首页”按钮 */}
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <button
              onClick={() => router.push('/')}
              className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium text-slate-100 hover:bg-slate-800"
            >
              返回首页
            </button>
            <span>账号：{email}</span>
            <button
              onClick={() => setShowBilling(true)}
              className="rounded-full border border-emerald-500 px-3 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10"
            >
              购买额度
            </button>
            <button
              onClick={handleLogout}
              className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium text-slate-100 hover:bg-slate-800"
            >
              退出登录
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl gap-4 px-4 py-4 md:px-6">
        {/* 左侧：图像工具 + 营销生成 */}
        <aside className="flex w-72 flex-col gap-4 rounded-2xl bg-slate-900/80 p-4 border border-slate-800">
          <div className="mb-1 text-xs font-semibold text-slate-300">图像工具</div>
          <div className="space-y-2 text-xs">
            <button
              className={
                'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left ' +
                (activeTool === 'estate'
                  ? 'bg-slate-800 text-slate-50'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800')
              }
              onClick={() => setActiveTool('estate')}
            >
              <span>房地产修图</span>
              <span className="text-[10px] rounded-full bg-blue-500/20 px-2 py-0.5 text-blue-300">推荐</span>
            </button>
            <button
              className={
                'w-full rounded-lg px-3 py-2 text-left ' +
                (activeTool === 'sky'
                  ? 'bg-slate-800 text-slate-50'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800')
              }
              onClick={() => setActiveTool('sky')}
            >
              更换天空
            </button>
            <button
              className={
                'w-full rounded-lg px-3 py-2 text-left ' +
                (activeTool === 'clutter'
                  ? 'bg-slate-800 text-slate-50'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800')
              }
              onClick={() => setActiveTool('clutter')}
            >
              智能去杂物
            </button>
            <button
              className={
                'w-full rounded-lg px-3 py-2 text-left ' +
                (activeTool === 'custom'
                  ? 'bg-slate-800 text-slate-50'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800')
              }
              onClick={() => setActiveTool('custom')}
            >
              待开发
            </button>
          </div>

          {/* 营销生成 */}
          <div className="mt-4 border-t border-slate-800 pt-3 text-xs">
            <div className="mb-2 text-xs font-semibold text-slate-300">营销生成</div>
            <button
              className={
                'mb-2 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left ' +
                (activeMarketingTool === 'listing'
                  ? 'bg-slate-800 text-slate-50'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800')
              }
              onClick={() => setActiveMarketingTool('listing')}
            >
              <span>一键写房屋简介</span>
            </button>
            <button className="mb-2 flex w-full items-center justify-between rounded-lg bg-slate-900 px-3 py-2 text-left text-slate-300 hover:bg-slate-800">
              <span>一键生成PDF</span>
              <span className="text-[10px] text-slate-500">敬请期待</span>
            </button>
            <button className="flex w-full items-center justify-between rounded-lg bg-slate-900 px-3 py-2 text-left text-slate-300 hover:bg-slate-800">
              <span>一键照片变视频</span>
              <span className="text-[10px] text-slate-500">敬请期待</span>
            </button>
          </div>

          {activeTool === 'estate' && (
            <>
              {/* estate 模式下，侧边栏不再单独管理项目和上传，只展示图像工具与营销生成 */}
            </>
          )}
        </aside>

        {/* 右侧主画布 + 任务列表 */}
        <section className="flex flex-1 flex-col gap-4">
          {/* 天空替换 / 智能去杂物：大框上传 + 简洁任务状态 */}
          {(activeTool === 'sky' || activeTool === 'clutter') && (
            <div className="flex flex-1 flex-col rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-xs">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-100">
                  当前工具：{activeTool === 'sky' ? '天空替换' : '杂物去除'}
                </span>
                <span className="text-[11px] text-slate-500">上传图片后会自动进入处理队列</span>
              </div>
              <div className="mb-4 rounded-xl border border-slate-700 bg-slate-950/60 p-4 text-center">
                <input
                  type="file"
                  accept="image/*,.cr2,.cr3,.arw,.nef,.nrw,.dng,.raf,.orf,.rw2,.srw"
                  multiple
                  onChange={handleSimpleUpload}
                  className="block w-full text-[11px] text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-blue-500 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-blue-600"
                />
                <p className="mt-2 text-[11px] text-slate-500">
                  选择图片后会创建修图任务，完成后可以在下方直接下载结果。
                </p>
              </div>

              <div className="flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40">
                {toolJobs.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
                    暂无任务，先上传几张图片试试吧。
                  </div>
                ) : (
                  <ul className="max-h-64 space-y-1 overflow-auto p-3">
                    {toolJobs.map(job => (
                      <li
                        key={job.id}
                        className="flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-2 text-[11px] text-slate-200"
                      >
                        <div className="flex flex-col">
                          <span className="text-[10px] text-slate-400">
                            {new Date(job.created_at).toLocaleString()}
                          </span>
                          <span>
                            {job.status === 'uploaded'
                              ? '已上传，等待处理'
                              : job.status === 'processing'
                              ? '处理中...'
                              : job.status === 'done'
                              ? '处理完成'
                              : job.status === 'failed'
                              ? '处理失败'
                              : job.status}
                          </span>
                          {job.error_message && (
                            <span className="mt-1 text-[10px] text-red-400">
                              错误：{job.error_message}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {job.status === 'done' && job.output_path ? (
                            <button
                              className="rounded-full border border-blue-500 px-2 py-0.5 text-[10px] text-blue-300 hover:bg-blue-500/10"
                              onClick={async () => {
                                const filename = getDownloadFilename(job)
                                const { data, error } = await supabase.storage
                                  .from('images')
                                  .createSignedUrl(job.output_path!, 60, { download: filename })

                                if (error || !data?.signedUrl) {
                                  console.error(error)
                                  alert('生成下载链接失败')
                                  return
                                }

                                triggerDownload(data.signedUrl, filename)
                              }}
                            >
                              下载结果
                            </button>
                          ) : job.status === 'failed' ? (
                            <button
                              className="rounded-full border border-red-500 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
                              onClick={async () => {
                                const { error } = await supabase
                                  .from('jobs')
                                  .update({ status: 'uploaded', error_message: null })
                                  .eq('id', job.id)

                                if (error) {
                                  console.error(error)
                                  alert('重试失败：' + error.message)
                                  return
                                }

                                setJobs(prev =>
                                  prev.map(j =>
                                    j.id === job.id
                                      ? { ...j, status: 'uploaded', error_message: null }
                                      : j,
                                  ),
                                )
                              }}
                            >
                              重新处理
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-500">&nbsp;</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* 自定义流程占位文案 / 其它工具 */}
          {activeTool === 'custom' && (
            <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-4 text-xs text-slate-400">
              <div className="relative flex flex-col items-center justify-center gap-3 text-center max-w-sm">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900/70 text-2xl">
                  🧪
                </div>
                <div className="text-sm font-semibold text-slate-100">自定义流程（敬请期待）</div>
                <p>该功能正在开发中，后续会支持自定义工作流和更高级的批量处理能力，敬请期待。</p>
              </div>
            </div>
          )}

          {/* 一键写房屋简介：表单 + 结果区域 */}
          {activeMarketingTool === 'listing' && (
            <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 text-xs">
              <div className="flex flex-col items-center justify-center text-center gap-2">
                <h2 className="text-sm font-semibold text-slate-100">一键写房屋简介</h2>
                <p className="text-[11px] text-slate-400">该功能正在升级中，敬请期待。</p>
              </div>
            </div>
          )}

          {/* 右侧主区域：房地产修图显示房源列表 */}
          {activeTool === 'estate' ? (
            <div className="flex flex-1 flex-col rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
              {/* 顶部新房源输入条 */}
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex flex-1 items-center gap-3">
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    placeholder="输入新项目地址（例如：123 Ocean Drive）..."
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleCreateProject}
                    className="whitespace-nowrap rounded-full bg-blue-500 px-4 py-2 text-xs font-medium text-white hover:bg-blue-600"
                  >
                    新建项目
                  </button>
                </div>
                <div className="text-[11px] text-slate-500 mt-1 md:mt-0">
                  共 {projects.length} 个项目
                </div>
              </div>

              {/* 房源列表 */}
              {projects.length === 0 ? (
                <div className="mt-10 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950/40 text-center text-xs text-slate-500">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900/80 text-2xl">
                    🏠
                  </div>
                  <p className="mb-1 text-sm font-medium text-slate-100">欢迎使用 AI 工作室</p>
                  <p>请在上方输入地址并点击“新建项目”以开始，所有图片将自动按项目分类整理。</p>
                </div>
              ) : (
                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)] flex-1">
                  {/* 项目列表 */}
                  <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 text-[11px] text-slate-400">
                      <span>项目列表（单击选中，双击打开上传面板）</span>
                    </div>
                    <table className="w-full text-xs">
                      <thead className="bg-slate-900/80 text-slate-300">
                        <tr>
                          <th className="px-4 py-2 text-left">项目</th>
                          <th className="px-4 py-2 text-left">照片</th>
                          <th className="px-4 py-2 text-left">创建于</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projects.map(project => {
                          const photoCount = jobs.filter(j => j.project_id === project.id).length
                          const isSelected = project.id === selectedProjectId
                          const isOpened = project.id === openedProjectId
                          return (
                            <tr
                              key={project.id}
                              className={
                                'cursor-pointer border-t border-slate-800 hover:bg-slate-900/70 ' +
                                (isOpened ? 'bg-slate-900' : isSelected ? 'bg-slate-900/70' : '')
                              }
                              onClick={() => {
                                setSelectedProjectId(project.id)
                                setOpenedProjectId(project.id)
                              }}
                            >
                              <td className="px-4 py-3 align-middle">
                                <div className="flex items-center gap-3">
                                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-800 text-[11px] text-slate-200">
                                    {project.name.slice(0, 2)}
                                  </div>
                                  <div className="flex flex-col">
                                    <span className="text-xs font-medium text-slate-100">{project.name}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3 align-middle text-slate-200">{photoCount}</td>
                              <td className="px-4 py-3 align-middle text-slate-400">
                                {new Date(project.created_at).toLocaleDateString()}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* 打开的项目详情 + 上传 / 下载 */}
                  <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs">
                    {!openedProjectId ? (
                      <div className="flex flex-1 flex-col items-center justify-center text-center text-slate-500">
                        <p>请在左侧双击一个项目以打开上传面板。</p>
                        <p className="mt-1 text-[11px]">每个项目都有自己独立的任务列表和图片。</p>
                      </div>
                    ) : (
                      <>
                        {(() => {
                          const project = projects.find(p => p.id === openedProjectId)
                          if (!project) {
                            return (
                              <div className="flex flex-1 items-center justify-center text-slate-500">
                                当前打开的项目不存在，请重新选择。
                              </div>
                            )
                          }
                          const projectJobs = jobs.filter(j => j.project_id === openedProjectId)
                          return (
                            <>
                              <div className="mb-3 flex items-center justify-between">
                                <div>
                                  <h2 className="text-sm font-semibold text-slate-100">{project.name}</h2>
                                  <p className="mt-1 text-[11px] text-slate-500">
                                    创建于：{new Date(project.created_at).toLocaleString()} · 共 {projectJobs.length} 张照片任务
                                  </p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => handleDownloadProjectAll(project.id)}
                                    className="rounded-full border border-slate-600 px-3 py-1 text-[11px] text-slate-100 hover:bg-slate-800"
                                  >
                                    下载本项目所有结果
                                  </button>
                                  <button
                                    onClick={() => setOpenedProjectId(null)}
                                    className="rounded-full border border-slate-600 px-3 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                                  >
                                    关闭面板
                                  </button>
                                </div>
                              </div>

                              {/* 上传区域：使用 pendingFiles + handleUploadSelected */}
                              <div className="mb-4 rounded-lg border border-slate-700 bg-slate-950/70 p-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-[11px] text-slate-300">选择要上传到该项目的照片</span>
                                  <span className="text-[11px] text-slate-500">
                                    已选 {pendingFiles.filter(p => p.checked).length} / {pendingFiles.length}
                                  </span>
                                </div>
                                <div className="mt-2 flex flex-col gap-2 md:flex-row md:items-center">
                                  <input
                                    type="file"
                                    accept="image/*,.cr2,.cr3,.arw,.nef,.nrw,.dng,.raf,.orf,.rw2,.srw"
                                    multiple
                                    onChange={handleFileChange}
                                    className="block w-full text-[11px] text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-blue-500 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-blue-600"
                                  />
                                  <button
                                    onClick={handleUploadSelected}
                                    className="mt-2 md:mt-0 whitespace-nowrap rounded-full bg-blue-500 px-4 py-1.5 text-[11px] font-medium text-white hover:bg-blue-600"
                                  >
                                    上传选中照片
                                  </button>
                                </div>
                                {pendingFiles.length > 0 && (
                                  <div className="mt-2 max-h-24 space-y-1 overflow-auto rounded border border-slate-800 bg-slate-950/60 p-2 text-[11px] text-slate-300">
                                    {pendingFiles.map(p => (
                                      <label
                                        key={p.id}
                                        className="flex cursor-pointer items-center gap-2 truncate"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={p.checked}
                                          onChange={e => {
                                            const checked = e.target.checked
                                            setPendingFiles(prev =>
                                              prev.map(item =>
                                                item.id === p.id ? { ...item, checked } : item,
                                              ),
                                            )
                                          }}
                                          className="h-3 w-3 rounded border-slate-600 bg-slate-900 text-blue-500"
                                        />
                                        <span className="truncate">{p.file.name}</span>
                                      </label>
                                    ))}
                                  </div>
                                )}

                                {projectUploading && projectUploadTotal > 0 && (
                                  <div className="mt-3">
                                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                                      <div
                                        className="h-full bg-blue-500 transition-all"
                                        style={{ width: `${(projectUploadDone / projectUploadTotal) * 100}%` }}
                                      />
                                    </div>
                                    <p className="mt-1 text-[11px] text-slate-400">
                                      正在上传 {projectUploadDone} / {projectUploadTotal} 张照片，请不要关闭页面…
                                    </p>
                                  </div>
                                )}
                              </div>

                              {/* 该项目的任务列表 */}
                              <div className="flex-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/50">
                                {projectJobs.length === 0 ? (
                                  <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
                                    暂无任务，先上传几张图片试试吧。
                                  </div>
                                ) : (
                                  <ul className="max-h-64 space-y-1 overflow-auto p-3">
                                    {projectJobs.map(job => (
                                      <li
                                        key={job.id}
                                        className="flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-2 text-[11px] text-slate-200"
                                      >
                                        <div className="flex flex-col">
                                          <span className="text-[10px] text-slate-400">
                                            {new Date(job.created_at).toLocaleString()} · 状态：
                                            {job.status === 'uploaded'
                                              ? '已上传，等待处理'
                                              : job.status === 'processing'
                                              ? '处理中...'
                                              : job.status === 'done'
                                              ? '处理完成'
                                              : job.status === 'failed'
                                              ? '处理失败'
                                              : job.status}
                                          </span>
                                          {job.error_message && (
                                            <span className="mt-1 text-[10px] text-red-400">
                                              错误：{job.error_message}
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {job.status === 'done' && job.output_path ? (
                                            <button
                                              className="rounded-full border border-blue-500 px-2 py-0.5 text-[10px] text-blue-300 hover:bg-blue-500/10"
                                              onClick={async () => {
                                                const filename = getDownloadFilename(job)
                                                const { data, error } = await supabase.storage
                                                  .from('images')
                                                  .createSignedUrl(job.output_path!, 60, { download: filename })

                                                if (error || !data?.signedUrl) {
                                                  console.error(error)
                                                  alert('生成下载链接失败')
                                                  return
                                                }

                                                triggerDownload(data.signedUrl, filename)
                                              }}
                                            >
                                              下载结果
                                            </button>
                                          ) : (
                                            <span className="text-[10px] text-slate-500">&nbsp;</span>
                                          )}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </>
                          )
                        })()}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,#6366F1_0,transparent_55%),radial-gradient(circle_at_bottom,#EC4899_0,transparent_55%)] opacity-40" />
              <div className="relative flex flex-col items-center justify-center gap-3 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900/70 text-2xl">
                  📷
                </div>
                <p className="text-sm font-medium text-slate-50">请在左侧选择工具并上传照片开始处理</p>
                <p className="text-xs text-slate-400">
                  上传的每张照片会自动创建一条任务，系统会依次处理并生成结果图。
                </p>
              </div>
            </div>
          )}

          {/* 任务列表：仅在房地产修图模式下显示 */}
          {activeTool === 'estate' && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">修图任务列表</h2>
              <div className="flex gap-2 text-xs">
                <button
                  onClick={handleDownloadAll}
                  className="rounded-full border border-slate-600 px-3 py-1 text-slate-100 hover:bg-slate-800"
                >
                  下载当前项目已完成图片
                </button>
                <button
                  onClick={handleDeleteSelectedJobs}
                  className="rounded-full border border-red-500 px-3 py-1 text-red-300 hover:bg-red-500/10"
                >
                  删除选中任务
                </button>
              </div>
            </div>

            {filteredJobs.length === 0 ? (
              <p className="text-xs text-slate-500">当前项目还没有任务，先上传几张照片吧。</p>
            ) : (
              <div className="max-h-72 overflow-auto rounded-md border border-slate-800 bg-slate-950/40">
                <table className="w-full text-xs">
                  <thead className="bg-slate-900/80 text-slate-300">
                    <tr>
                      <th className="border-b border-slate-800 px-2 py-1 text-left">选择</th>
                      <th className="border-b border-slate-800 px-2 py-1 text-left">时间</th>
                      <th className="border-b border-slate-800 px-2 py-1 text-left">状态</th>
                      <th className="border-b border-slate-800 px-2 py-1 text-left">原始路径</th>
                      <th className="border-b border-slate-800 px-2 py-1 text-left">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredJobs.map(job => (
                      <tr key={job.id} className="odd:bg-slate-900/40 even:bg-slate-900/20">
                        <td className="border-t border-slate-800 px-2 py-1">
                          <input
                            type="checkbox"
                            checked={selectedJobIds.includes(job.id)}
                            onChange={e => toggleJobSelection(job.id, e.target.checked)}
                          />
                        </td>
                        <td className="border-t border-slate-800 px-2 py-1 align-top">
                          {new Date(job.created_at).toLocaleString()}
                        </td>
                        <td className="border-t border-slate-800 px-2 py-1 align-top">
                          {job.status === 'uploaded'
                            ? '已上传，待处理'
                            : job.status === 'processing'
                            ? '处理中'
                            : job.status === 'done'
                            ? '已完成'
                            : job.status === 'failed'
                            ? '处理失败'
                            : job.status}
                        </td>
                        <td className="border-t border-slate-800 px-2 py-1 align-top max-w-xs truncate text-slate-300">
                          {job.input_path}
                        </td>
                        <td className="border-t border-slate-800 px-2 py-1 align-top space-x-2">
                          {job.status === 'done' && job.output_path ? (
                            <button
                              className="text-blue-300 underline"
                              onClick={async () => {
                                const filename = getDownloadFilename(job)
                                const { data, error } = await supabase.storage
                                  .from('images')
                                  .createSignedUrl(job.output_path!, 60, { download: filename })

                                if (error || !data?.signedUrl) {
                                  console.error(error)
                                  alert('生成下载链接失败')
                                  return
                                }

                                triggerDownload(data.signedUrl, filename)
                              }}
                            >
                              下载结果
                            </button>
                          ) : job.status === 'failed' ? (
                            <button
                              className="text-red-300 underline"
                              onClick={async () => {
                                const { error } = await supabase
                                  .from('jobs')
                                  .update({ status: 'uploaded', error_message: null })
                                  .eq('id', job.id)

                                if (error) {
                                  console.error(error)
                                  alert('重试失败：' + error.message)
                                  return
                                }

                                setJobs(prev =>
                                  prev.map(j =>
                                    j.id === job.id
                                      ? { ...j, status: 'uploaded', error_message: null }
                                      : j,
                                  ),
                                )
                              }}
                            >
                              重新处理
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-500">等待处理</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          )}
        </section>
      </main>
    </div>
  )
}
