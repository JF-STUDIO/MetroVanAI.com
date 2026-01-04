import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Workflow, User, Job, JobAsset, PipelineGroupItem } from '../types';
import { jobService } from '../services/jobService';
import { supabase } from '../services/supabaseClient';
import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
  || (import.meta.env.DEV ? 'http://localhost:4000/api' : '/api');

// Props for the main component
interface EditorProps {
  user: User;
  workflows: Workflow[];
  onUpdateUser: (user: User) => void;
}

// Data structure for an image being processed
interface ImageItem {
  id: string; 
  file: File;
  preview: string;
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'failed';
  progress: number;
  statusText?: string;
  isRaw?: boolean;
}

type HistoryJob = Job & { photo_tools?: { name?: string } | null; workflows?: { display_name?: string } | null };
type GalleryItem = {
  id: string;
  label: string;
  preview?: string;
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'failed';
  progress: number;
  stage?: 'input' | 'hdr' | 'ai' | 'output';
  error?: string | null;
  groupType?: string | null;
  groupSize?: number | null;
  representativeIndex?: number | null;
  isSkipped?: boolean;
  frames?: {
    id: string;
    filename: string;
    order: number;
    preview_url?: string | null;
    input_kind?: string | null;
  }[];
};

// The auto-playing, aspect-ratio-correct slider component
const ComparisonSlider: React.FC<{ original: string; processed: string }> = ({ original, processed }) => {
  const [sliderPos, setSliderPos] = useState(50);
  const [isAnimating, setIsAnimating] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isAnimating) return;
    let direction = 1;
    const interval = setInterval(() => {
      setSliderPos(prev => {
        const next = prev + 0.5 * direction;
        if (next > 100 || next < 0) {
          direction *= -1;
          return prev;
        }
        return next;
      });
    }, 20);
    return () => clearInterval(interval);
  }, [isAnimating]);

  const handleMove = (e: React.MouseEvent | React.TouchEvent) => {
    setIsAnimating(false);
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = 'touches' in e ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
    const position = ((x - rect.left) / rect.width) * 100;
    setSliderPos(Math.min(Math.max(position, 0), 100));
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden cursor-ew-resize select-none bg-black"
      onMouseMove={handleMove}
      onTouchMove={handleMove}
      onMouseLeave={() => setIsAnimating(true)}
    >
      <img src={original} className="absolute inset-0 w-full h-full object-cover" alt="Before" loading="lazy" />
      <div className="absolute inset-0 w-full h-full overflow-hidden" style={{ clipPath: `inset(0 0 0 ${sliderPos}%)` }}>
        <img src={processed} className="absolute inset-0 w-full h-full object-cover" alt="After" loading="lazy" />
      </div>
      <div className="absolute top-0 bottom-0 w-0.5 bg-white/50 shadow-[0_0_15px_rgba(0,0,0,0.8)] z-10" style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)' }}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-2xl border border-gray-200">
          <i className="fa-solid fa-arrows-left-right text-indigo-600 text-[10px]"></i>
        </div>
      </div>
    </div>
  );
};

// Main Editor Component with multiple views
const Editor: React.FC<EditorProps> = ({ user, workflows, onUpdateUser }) => {
  const [activeTool, setActiveTool] = useState<Workflow | null>(null);
  const [showProjectInput, setShowProjectInput] = useState(false);
  const [uploadImages, setUploadImages] = useState<ImageItem[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [projectName, setProjectName] = useState('');
  const [jobStatus, setJobStatus] = useState('idle');
  const [zipUrl, setZipUrl] = useState<string | null>(null);
  const [downloadType, setDownloadType] = useState<'zip' | 'jpg' | null>(null);
  const [pipelineItems, setPipelineItems] = useState<PipelineGroupItem[]>([]);
  const [pipelineProgress, setPipelineProgress] = useState<number | null>(null);
  const [excludedGroupIds, setExcludedGroupIds] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<Array<{ status: 'pending' | 'ready'; url?: string }>>([]);
  const [previewSummary, setPreviewSummary] = useState<{ total: number; ready: number } | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [history, setHistory] = useState<HistoryJob[]>([]);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [autoUploadQueued, setAutoUploadQueued] = useState(false);
  const [uploadComplete, setUploadComplete] = useState(false);
  const editorStateKey = 'mvai:editor_state';
  const [pendingActiveIndex, setPendingActiveIndex] = useState<number | null>(null);
  const [runpodQueue, setRunpodQueue] = useState<{ pending: number; etaSeconds: number } | null>(null);
  const [notice, setNotice] = useState<{ type: 'error' | 'info' | 'success'; message: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
  } | null>(null);
  const pipelineStages = new Set([
    'reserved',
    'input_resolved',
    'preprocessing',
    'hdr_processing',
    'workflow_running',
    'ai_processing',
    'postprocess',
    'packaging',
    'zipping'
  ]);
  const [resumeAttempted, setResumeAttempted] = useState(false);
  const rawExtensions = new Set(['arw', 'cr2', 'cr3', 'nef', 'dng', 'rw2', 'orf', 'raf']);
  const isRawFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    return ext ? rawExtensions.has(ext) : false;
  };
  const multipartThreshold = 50 * 1024 * 1024; // 50MB
  const resetStreamState = () => {
    setImages([]);
  };

  useEffect(() => {
    if (!lightboxUrl) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLightboxUrl(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [lightboxUrl]);

  const saveLastJob = (jobId: string, workflowId: string) => {
    try {
      localStorage.setItem('mvai:last_job', JSON.stringify({ jobId, workflowId, ts: Date.now() }));
    } catch (error) {
      console.warn('Failed to store last job', error);
    }
  };

  // 新 SSE：按 job 订阅事件，逐张更新
  useEffect(() => {
    if (!job?.id) return;
    let es: EventSource | null = null;
    let closed = false;

    const connect = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || closed) return;
      const streamUrl = `${API_BASE_URL}/jobs/${job.id}/events?token=${encodeURIComponent(token)}`;
      es = new EventSource(streamUrl);

      es.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'image_ready') {
          setImages(prev => {
            const next = [...prev];
            next[data.index] = { status: 'ready', url: data.imageUrl };
            return next;
          });
          setPipelineItems(prev => {
            if (!prev || prev.length === 0) return prev;
            const next = [...prev];
            const item = next[data.index];
            if (!item) return prev;
            next[data.index] = { ...item, output_url: data.imageUrl, status: 'ai_ok' };
            return next;
          });
        }

        if (data.type === 'grouping_progress' && typeof data.progress === 'number') {
          setPipelineProgress(Math.min(100, Math.max(0, Math.round(data.progress))));
        }

        if (data.type === 'grouped' && (Array.isArray(data.items) || Array.isArray(data.groups))) {
          const source = Array.isArray(data.items) ? data.items : data.groups;
          // 兼容 Runpod 回调的 groups 结构：{ id?, index?, resultKey?, previewKey? }
          const items: PipelineGroupItem[] = source.map((g: any, idx: number) => ({
            id: g.id || g.groupId || `group-${idx + 1}`,
            group_index: g.groupIndex ?? g.index ?? idx + 1,
            status: g.status || 'processing',
            group_type: g.groupType ?? null,
            output_filename: g.outputFilename ?? null,
            hdr_url: g.hdrUrl || null,
            output_url: g.resultKey || g.outputUrl || null,
            preview_url: g.previewKey || g.preview || g.resultKey || g.outputUrl || null,
            group_size: g.groupSize ?? null,
            representative_index: g.representativeIndex ?? null,
            frames: g.frames || [],
            last_error: g.error || null,
          }));
          setPipelineItems(items);
          setPipelineProgress(0);
          setImages(() => items.map(() => ({ status: 'pending' })));
        }

        if (data.type === 'group_status_changed' && typeof data.index === 'number') {
          setPipelineItems(prev => {
            if (!prev || prev.length === 0) return prev;
            const next = [...prev];
            const item = next[data.index];
            if (!item) return prev;
            next[data.index] = {
              ...item,
              status: data.status || item.status,
              last_error: data.error || item.last_error,
              is_skipped: data.status === 'skipped' ? true : item.is_skipped
            };
            return next;
          });
          if (data.status && typeof data.status === 'string') {
            setJobStatus(data.status);
          }
        }

        if (data.type === 'group_done' && typeof data.index === 'number') {
          setPipelineItems(prev => {
            if (!prev || prev.length === 0) return prev;
            const next = [...prev];
            const item = next[data.index];
            if (!item) return prev;
            next[data.index] = { ...item, status: 'ai_ok', last_error: null };
            return next;
          });
        }

        if (data.type === 'group_failed' && typeof data.index === 'number') {
          setPipelineItems(prev => {
            if (!prev || prev.length === 0) return prev;
            const next = [...prev];
            const item = next[data.index];
            if (!item) return prev;
            next[data.index] = { ...item, status: 'failed', last_error: data.error || item.last_error };
            return next;
          });
          pushNotice('error', data.error || '分组处理失败');
        }

        if (data.type === 'job_done') {
          closed = true;
          es?.close();
          setJob(prev => (prev ? { ...prev, status: 'completed', progress: 100 } : prev));
          setJobStatus('completed');
          try {
            const download = await jobService.getPresignedDownloadUrl(job.id);
            setZipUrl(download?.url || null);
            setDownloadType(download?.type || null);
          } catch {
            // ignore
          }
          try {
            const profile = await jobService.getProfile();
            onUpdateUser({ ...user, points: profile.available_credits ?? profile.points ?? 0 });
          } catch {
            // ignore
          }
        }

        if (data.type === 'error') {
          closed = true;
          es?.close();
          setJobStatus('failed');
          pushNotice('error', data.message || 'workflow failed');
        }
      };

      es.onerror = () => {
        if (closed) return;
        es?.close();
        closed = true;
      };
    };

    void connect();

    return () => {
      closed = true;
      es?.close();
    };
  }, [job?.id]);

  useEffect(() => {
    if (!job?.id) return;
    if (pipelineItems.length === 0) return;
    setImages(prev => {
      if (prev.length === pipelineItems.length) return prev;
      const next = [...prev];
      while (next.length < pipelineItems.length) {
        next.push({ status: 'pending' });
      }
      return next.slice(0, pipelineItems.length);
    });
  }, [pipelineItems.length, job?.id]);

  useEffect(() => {
    if (pipelineItems.length === 0) {
      setExcludedGroupIds(new Set());
    }
  }, [pipelineItems.length]);

  useEffect(() => {
    if (pipelineItems.length === 0) return;
    setExcludedGroupIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      const ids = new Set(pipelineItems.map((item) => item.id));
      for (const id of Array.from(next)) {
        if (!ids.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      pipelineItems.forEach((item) => {
        const isSkipped = item.status === 'skipped' || item.is_skipped;
        if (isSkipped && !next.has(item.id)) {
          next.add(item.id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [pipelineItems]);

  const loadHistory = async (page = 1) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await jobService.getHistory(page);
      const data = Array.isArray(response?.data) ? response.data : [];
      const count = Number(response?.count || 0);
      setHistory(prev => (page === 1 ? data : [...prev, ...data]));
      setHistoryCount(count);
      setHistoryPage(page);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load projects.');
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadHistory(1);
  }, [user.id]);

  useEffect(() => {
    if (resumeAttempted || activeTool || workflows.length === 0) return;
    let cached: { jobId?: string; workflowId?: string } | null = null;
    let editorState: {
      mode?: 'projects' | 'studio';
      workflowId?: string;
      jobId?: string;
      search?: string;
      activeIndex?: number | null;
    } | null = null;
    try {
      cached = JSON.parse(localStorage.getItem('mvai:last_job') || 'null');
    } catch (error) {
      cached = null;
    }
    try {
      editorState = JSON.parse(localStorage.getItem(editorStateKey) || 'null');
    } catch (error) {
      editorState = null;
    }

    const preferLastJob = Boolean(cached?.jobId && cached?.workflowId);
    if (editorState?.mode === 'projects' && editorState.workflowId && !preferLastJob) {
      const workflow = workflows.find(tool => tool.id === editorState?.workflowId);
      if (workflow) {
        setActiveTool(workflow);
        setShowProjectInput(true);
        setShowNewProjectForm(false);
        setProjectSearch(editorState.search || '');
        setUploadImages([]);
        setActiveIndex(null);
        setZipUrl(null);
        setDownloadType(null);
        setPipelineItems([]);
        setPipelineProgress(null);
        setPreviewSummary(null);
        resetStreamState();
        setUploadComplete(true);
      }
      setResumeAttempted(true);
      return;
    }
    const jobId = cached?.jobId || editorState?.jobId;
    const workflowId = cached?.workflowId || editorState?.workflowId;
    if (!jobId || !workflowId) {
      setResumeAttempted(true);
      return;
    }
    const workflow = workflows.find(tool => tool.id === workflowId);
    if (!workflow) {
      setResumeAttempted(true);
      return;
    }
    setActiveTool(workflow);
    setShowProjectInput(false);
    setUploadImages([]);
    setActiveIndex(null);
    setZipUrl(null);
    setDownloadType(null);
    setPipelineItems([]);
    setPipelineProgress(null);
    setPreviewSummary(null);
    resetStreamState();
    setUploadComplete(true);
    setPendingActiveIndex(typeof editorState?.activeIndex === 'number' ? editorState.activeIndex : null);
    jobService.getPipelineStatus(jobId)
      .then(async (response) => {
        const pipelineJob = response.job;
        setJob(pipelineJob);
        setProjectName(pipelineJob.project_name || '');
        setJobStatus(pipelineJob.status);
        if (Array.isArray(response.items)) {
          setPipelineItems(response.items);
        }
        if (typeof response.progress === 'number') {
          setPipelineProgress(response.progress);
        }
        if (response?.previews) {
          setPreviewSummary(response.previews);
        }
        if (pipelineJob.status === 'completed' || pipelineJob.status === 'partial') {
          const download = await jobService.getPresignedDownloadUrl(pipelineJob.id);
          setZipUrl(download?.url || null);
          setDownloadType(download?.type || null);
        }
      })
      .catch(() => {
        localStorage.removeItem('mvai:last_job');
      })
      .finally(() => {
        setResumeAttempted(true);
      });
  }, [workflows, activeTool, resumeAttempted]);

  const saveEditorState = (payload: {
    mode: 'projects' | 'studio';
    workflowId?: string | null;
    jobId?: string | null;
    search?: string;
    activeIndex?: number | null;
  }) => {
    localStorage.setItem(editorStateKey, JSON.stringify({
      mode: payload.mode,
      workflowId: payload.workflowId || undefined,
      jobId: payload.jobId || undefined,
      search: payload.search ?? undefined,
      activeIndex: typeof payload.activeIndex === 'number' ? payload.activeIndex : undefined
    }));
  };

  const clearEditorState = () => {
    localStorage.removeItem(editorStateKey);
  };

  useEffect(() => {
    if (!job || !activeTool) return;
    saveEditorState({
      mode: 'studio',
      workflowId: activeTool.id,
      jobId: job.id,
      activeIndex
    });
  }, [job?.id, activeTool?.id, activeIndex]);

  const pushNotice = (type: 'error' | 'info' | 'success', message: string) => {
    setNotice({ type, message });
  };

  const openConfirm = (payload: {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
  }) => {
    setConfirmDialog(payload);
  };

  useEffect(() => {
    if (!confirmDialog) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConfirmDialog(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [confirmDialog]);

  const formatDate = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  };

  const openExistingJob = async (item: HistoryJob) => {
    setConfirmDialog(null);
    setUploadImages([]);
    setActiveIndex(null);
    setZipUrl(null);
    setDownloadType(null);
    setPreviewSummary(null);
    resetStreamState();
    setProjectName(item.project_name || '');
    setJobStatus(item.status);
    setJob(item as Job);
    setShowProjectInput(false);
    setUploadComplete(true);
    setShowNewProjectForm(false);
    if (item.workflow_id) {
      saveLastJob(item.id, item.workflow_id);
      saveEditorState({ mode: 'studio', workflowId: item.workflow_id, jobId: item.id, activeIndex });
    }

    try {
      if (item.workflow_id) {
        const response = await jobService.getPipelineStatus(item.id);
        const pipelineJob = response.job;
        setJob(pipelineJob);
        setJobStatus(pipelineJob.status);
        if (Array.isArray(response.items)) {
          setPipelineItems(response.items);
        }
        if (typeof response.progress === 'number') {
          setPipelineProgress(response.progress);
        }
        if (response?.previews) {
          setPreviewSummary(response.previews);
        }
        if (pipelineJob.status === 'completed' || pipelineJob.status === 'partial') {
          const download = await jobService.getPresignedDownloadUrl(pipelineJob.id);
          setZipUrl(download?.url || null);
          setDownloadType(download?.type || null);
        } else if (pipelineStages.has(pipelineJob.status)) {
        }
      } else {
        setPipelineItems([]);
        setPipelineProgress(null);
        setPreviewSummary(null);
        resetStreamState();
        const jobData = await jobService.getJobStatus(item.id);
        setJob(jobData);
        setJobStatus(jobData.status);
        if (jobData.status === 'completed') {
          const download = await jobService.getPresignedDownloadUrl(jobData.id);
          setZipUrl(download?.url || null);
          setDownloadType(download?.type || null);
        } else if (pipelineStages.has(jobData.status)) {
        }
      }
    } catch (err) {
      console.error('Failed to load project:', err);
    }
  };

  const deleteExistingJob = async (item: HistoryJob) => {
    try {
      await jobService.deleteJob(item.id);
      setHistory(prev => prev.filter(jobItem => jobItem.id !== item.id));
      setHistoryCount(prev => Math.max(prev - 1, 0));
      if (job?.id === item.id) {
        setJob(null);
        setUploadImages([]);
        setJobStatus('idle');
        setProjectName('');
        setZipUrl(null);
        setDownloadType(null);
        setPipelineItems([]);
        setPipelineProgress(null);
        setPreviewSummary(null);
        resetStreamState();
        localStorage.removeItem('mvai:last_job');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete project.';
      pushNotice('error', message);
    }
  };

  const requestDeleteJob = (item: HistoryJob) => {
    openConfirm({
      title: 'Delete project?',
      message: `Delete project "${item.project_name || 'Untitled Project'}"? This will remove files and cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => deleteExistingJob(item)
    });
  };

  // Unified file handler for both click and drop
  const processFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (!job) {
      pushNotice('error', 'Please create or select a project first.');
      return;
    }
    const uploadAllowedStatuses = new Set([
      'idle',
      'draft',
      'uploaded',
      'analyzing',
      'input_resolved',
      'failed',
      'partial',
      'completed',
      'canceled'
    ]);
    const isProcessing = pipelineStages.has(jobStatus) && jobStatus !== 'input_resolved';
    if (!uploadAllowedStatuses.has(jobStatus) || isProcessing) {
      pushNotice('info', 'Processing is in progress. Create a new project to upload more files.');
      return;
    }
    if (job && isProcessing) {
      pushNotice('error', 'Processing is already running. Please wait for it to finish before adding more files.');
      return;
    }
    const maxFiles = Number(import.meta.env.VITE_MAX_UPLOAD_FILES || 0);
    const maxFileBytes = Number(import.meta.env.VITE_MAX_FILE_BYTES || (200 * 1024 * 1024));
    if (maxFiles > 0 && uploadImages.length + files.length > maxFiles) {
      pushNotice('error', `Too many files. Max ${maxFiles} per project.`);
      return;
    }
    if (maxFileBytes > 0) {
      const oversized = files.find((file) => file.size > maxFileBytes);
      if (oversized) {
        pushNotice('error', `File too large: ${oversized.name}`);
        return;
      }
    }

    const newItems: ImageItem[] = files.map(file => {
      const raw = isRawFile(file);
      return {
        id: Math.random().toString(36).substring(2, 9),
        file,
        preview: raw ? '' : URL.createObjectURL(file),
        status: 'pending',
        progress: 0,
        statusText: raw ? 'RAW' : 'Ready',
        isRaw: raw
      };
    });
    if (pipelineItems.length > 0) {
      setPipelineItems([]);
      setPipelineProgress(null);
      setPreviewSummary(null);
      resetStreamState();
    }
    setUploadImages(prev => [...prev, ...newItems]);
    if (activeIndex === null) setActiveIndex(uploadImages.length - 1 + newItems.length);
    if (uploadAllowedStatuses.has(jobStatus)) {
      setAutoUploadQueued(true);
    }
  };

  // Handle new files from input click
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(e.target.files);
    e.target.value = '';
  };

  // Drag and Drop handlers
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    processFiles(e.dataTransfer.files);
  };

  const handleRetryMissing = async () => {
    if (!job) return;
    try {
      const result = await jobService.retryMissing(job.id);
      if (result?.retried > 0) {
        setJob(prev => (prev ? { ...prev, status: 'reserved' } : prev));
        setJobStatus('reserved');
        pushNotice('success', 'Retry queued. Processing will resume.');
      } else {
        pushNotice('info', 'No retryable groups.');
      }
    } catch (err) {
      pushNotice('error', err instanceof Error ? err.message : 'Retry failed.');
    }
  };

  // Main batch processing logic
  const startBatchProcess = async () => {
    if (!activeTool || uploadImages.length === 0 || !job) {
      pushNotice('error', 'Missing job details. Select a project and upload files first.');
      return;
    }

    try {
      setNotice(null);
      setJobStatus('uploading');
      setUploadComplete(false);
      setRunpodQueue(null);
      setPipelineItems([]);
      setPipelineProgress(null);
      setPreviewSummary(null);
      resetStreamState();
      const presignedData: { r2Key: string; putUrl: string; fileName: string }[] = await jobService.getPresignedRawUploadUrls(
        job.id,
        uploadImages.map(img => ({ name: img.file.name, type: img.file.type || 'application/octet-stream', size: img.file.size }))
      );

      const uploadedFiles: { r2_key: string; filename: string }[] = [];

      const uploadSingle = async (img: ImageItem) => {
        const presignInfo = presignedData.find((p) => p.fileName === img.file.name);
        if (!presignInfo) return;
        img.status = 'uploading';
        await axios.put(presignInfo.putUrl, img.file, {
          headers: { 'Content-Type': img.file.type || 'application/octet-stream' },
          onUploadProgress: (progressEvent) => {
            const total = progressEvent.total || 1;
            img.progress = Math.round((progressEvent.loaded * 100) / total);
            setUploadImages(prev => [...prev]);
          }
        });
        uploadedFiles.push({ r2_key: presignInfo.r2Key, filename: img.file.name });
        img.status = 'processing';
        img.statusText = 'Uploaded';
        img.progress = 100;
        setUploadImages(prev => [...prev]);
      };

      const uploadMultipart = async (img: ImageItem) => {
        img.status = 'uploading';
        const init = await jobService.createMultipartUpload(job.id, {
          name: img.file.name,
          type: img.file.type || 'application/octet-stream',
          size: img.file.size
        });
        const parts: { partNumber: number; etag: string }[] = [];
        let loadedTotal = 0;
        const maxParallel = 3;
        const queue = [...init.partUrls];

        const uploadPart = async (part: any, attempt = 1): Promise<void> => {
          const start = (part.partNumber - 1) * init.partSize;
          const end = Math.min(start + init.partSize, img.file.size);
          const chunk = img.file.slice(start, end);
          try {
            const response = await axios.put(part.url, chunk, {
              headers: { 'Content-Type': img.file.type || 'application/octet-stream' }
            });
            const etag = (response.headers?.etag || response.headers?.ETag || '').replace(/"/g, '');
            if (!etag) throw new Error('Missing ETag for multipart part');
            parts.push({ partNumber: part.partNumber, etag });
            loadedTotal += (end - start);
            img.progress = Math.min(99, Math.round((loadedTotal / img.file.size) * 100));
            setUploadImages(prev => [...prev]);
          } catch (error) {
            if (attempt < 3) {
              await uploadPart(part, attempt + 1);
              return;
            }
            throw error;
          }
        };

        const workers = Array.from({ length: Math.min(maxParallel, queue.length) }, async () => {
          while (queue.length) {
            const part = queue.shift();
            if (!part) break;
            await uploadPart(part);
          }
        });

        await Promise.all(workers);
        await jobService.completeMultipartUpload(job.id, { uploadId: init.uploadId, key: init.key, parts });
        uploadedFiles.push({ r2_key: init.key, filename: img.file.name });
        img.status = 'processing';
        img.statusText = 'Uploaded';
        img.progress = 100;
        setUploadImages(prev => [...prev]);
      };

      await Promise.all(uploadImages.map(async (img) => {
        try {
          if (img.file.size >= multipartThreshold) {
            await uploadMultipart(img);
          } else {
            await uploadSingle(img);
          }
        } catch (error) {
          img.status = 'failed';
          img.statusText = 'Failed';
          setUploadImages(prev => [...prev]);
          throw error;
        }
      }));

      await jobService.uploadComplete(job.id, uploadedFiles);
      setUploadComplete(true);
      setPreviewSummary({ total: uploadedFiles.length, ready: 0 });
      setJobStatus('grouping');
      // 触发 RunPod 分组 + HDR
      const runpodResp = await jobService.triggerRunpod(job.id, { mode: 'group' });
      if (runpodResp?.queue_pending !== undefined) {
        setRunpodQueue({
          pending: Math.max(Number(runpodResp.queue_pending) || 0, 0),
          etaSeconds: Math.max(Number(runpodResp.eta_seconds) || 0, 0)
        });
      }
      // 生成 RAW 内嵌 JPG 预览（异步，不阻塞）
      jobService.generatePreviews(job.id).catch((error) => {
        console.warn('Failed to enqueue previews', error);
      });
    } catch (err) {
      if (err instanceof Error) {
        pushNotice('error', `Upload failed: ${err.message}`);
      } else {
        pushNotice('error', 'An unknown upload error occurred.');
      }
      setJobStatus('idle');
      setUploadComplete(false);
    }
  };

  const autoUploadStatuses = new Set([
    'idle',
    'draft',
    'uploaded',
    'analyzing',
    'input_resolved',
    'failed',
    'partial',
    'completed',
    'canceled'
  ]);

  useEffect(() => {
    if (!autoUploadQueued) return;
    if (!job) return;
    if (!autoUploadStatuses.has(jobStatus)) return;
    if (uploadImages.length === 0) return;
    setAutoUploadQueued(false);
    void startBatchProcess();
  }, [autoUploadQueued, uploadImages.length, job?.id, jobStatus]);

  const startEnhanceProcess = async () => {
    if (!job || !activeTool) {
      pushNotice('error', 'Missing job details. Select a project first.');
      return;
    }
    try {
      setNotice(null);
      let currentItems = pipelineItems;
      if (currentItems.length === 0) {
        const response = await jobService.getPipelineStatus(job.id);
        if (Array.isArray(response?.items)) {
          setPipelineItems(response.items);
          currentItems = response.items;
        }
        if (response?.previews) {
          setPreviewSummary(response.previews);
        }
      }
      const serverSkipped = currentItems.filter((item) => item.status === 'skipped' || item.is_skipped).map((item) => item.id);
      const selectedSkips = jobStatus === 'input_resolved' ? Array.from(excludedGroupIds) : [];
      const skipIds = Array.from(new Set([...serverSkipped, ...selectedSkips]));
      const activeCountFromItems = currentItems.length > 0
        ? currentItems.filter((item) => !skipIds.includes(item.id)).length
        : Math.max((job.estimated_units || 0) - skipIds.length, 0);
      if (activeCountFromItems <= 0) {
        pushNotice('error', 'Keep at least one group selected for HDR processing.');
        return;
      }
      const placeholderCount = activeCountFromItems || previewSummary?.total || 0;
      if (placeholderCount > 0) {
        setImages(Array.from({ length: placeholderCount }, () => ({ status: 'pending' })));
      }
      const startResponse = await jobService.startJob(job.id, skipIds.length > 0 ? { skipGroupIds: skipIds } : undefined);
      if (skipIds.length > 0) {
        setPipelineItems((prev) => prev.map((item) => (
          skipIds.includes(item.id) ? { ...item, status: 'skipped', is_skipped: true } : item
        )));
        setExcludedGroupIds(new Set(skipIds));
      }
      setJob((prev) => (prev ? { ...prev, estimated_units: activeCountFromItems, status: 'hdr_processing' } : prev));
      setJobStatus('hdr_processing');
      const profile = await jobService.getProfile();
      onUpdateUser({ ...user, points: profile.available_credits ?? profile.points ?? 0 });
      const balanceRow = Array.isArray(startResponse?.balance) ? startResponse.balance[0] : startResponse?.balance;
      if (balanceRow?.available_credits !== undefined) {
        onUpdateUser({ ...user, points: balanceRow.available_credits });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start processing.';
      pushNotice('error', message);
    }
  };

  // UI Flow Handlers
  const handleSelectTool = (tool: Workflow) => {
    setActiveTool(tool);
    setShowProjectInput(true);
    setShowNewProjectForm(false);
    setProjectSearch('');
    setPipelineItems([]);
    setPipelineProgress(null);
    setPreviewSummary(null);
    setLightboxUrl(null);
    resetStreamState();
    setUploadComplete(false);
    localStorage.removeItem('mvai:last_job');
    saveEditorState({ mode: 'projects', workflowId: tool.id, jobId: null, search: '' });
  };
  
  const handleProjectCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName || !activeTool) return;
    try {
      setNotice(null);
      const newJob = await jobService.createWorkflowJob(activeTool.id, projectName);
      setJob(newJob);
      setJobStatus(newJob.status)
      setShowProjectInput(false);
      setShowNewProjectForm(false);
      setUploadComplete(false);
      setPipelineItems([]);
      setPipelineProgress(null);
      setPreviewSummary(null);
      setLightboxUrl(null);
      resetStreamState();
      setRunpodQueue(null);
      saveLastJob(newJob.id, activeTool.id);
      saveEditorState({ mode: 'studio', workflowId: activeTool.id, jobId: newJob.id, activeIndex: null });
      setHistory(prev => [{
        ...(newJob as Job),
        workflows: { display_name: activeTool.display_name },
        workflow_id: activeTool.id
      }, ...prev]);
      setHistoryCount(prev => prev + 1);
    } catch (error) {
      if (error instanceof Error) {
        pushNotice('error', `Failed to create project: ${error.message}`);
      } else {
        pushNotice('error', 'An unknown error occurred while creating the project.');
      }
    }
  };

  const toggleGroupExclusion = (groupId: string) => {
    if (jobStatus !== 'input_resolved') return;
    const willExclude = !excludedGroupIds.has(groupId);
    setExcludedGroupIds((prev) => {
      const next = new Set(prev);
      if (willExclude) {
        next.add(groupId);
      } else {
        next.delete(groupId);
      }
      return next;
    });
    setPipelineItems((prev) => prev.map((item) => {
      if (item.id !== groupId) return item;
      if (willExclude) return { ...item, status: 'skipped', is_skipped: true };
      if (item.status === 'skipped' || item.is_skipped) {
        return { ...item, status: 'queued', is_skipped: false };
      }
      return item;
    }));
  };

  const mapUploadItem = (item: ImageItem): GalleryItem => ({
    id: item.id,
    label: item.file.name,
    preview: item.preview,
    status: item.status,
    progress: item.progress,
    stage: 'input'
  });

  const hasPendingUploads = uploadImages.some((img) => img.status === 'pending' || img.status === 'uploading');
  const showRawPreviews = jobStatus === 'idle' || jobStatus === 'draft';
  const showUploadOnly = jobStatus === 'uploading';

  const uploadProgress = uploadImages.length
    ? Math.round(uploadImages.reduce((sum, img) => sum + img.progress, 0) / uploadImages.length)
    : 0;
  const isFinalizingUpload = jobStatus === 'uploading' && uploadImages.length > 0 && uploadProgress >= 100 && !uploadComplete;
  const displayUploadProgress = isFinalizingUpload ? 99 : uploadProgress;

  const pipelineProgressValue = typeof pipelineProgress === 'number'
    ? pipelineProgress
    : typeof job?.progress === 'number'
      ? job.progress
      : null;

  const previewTotal = previewSummary?.total ?? 0;
  const previewReady = previewSummary?.ready ?? 0;
  const previewProgress = previewTotal > 0
    ? Math.round((previewReady / previewTotal) * 100)
    : 0;

  const previewInProgress = previewTotal > 0 && previewReady < previewTotal;
  const processingActive = (pipelineStages.has(jobStatus) || jobStatus === 'analyzing') && jobStatus !== 'input_resolved';
  const hideGalleryUntilPreviewsDone = false;
  const serverSkippedIds = useMemo(() => {
    const ids = pipelineItems
      .filter((item) => item.status === 'skipped' || item.is_skipped)
      .map((item) => item.id);
    return new Set(ids);
  }, [pipelineItems]);
  const effectiveSkippedIds = useMemo(() => {
    const combined = new Set<string>(Array.from(serverSkippedIds));
    if (jobStatus === 'input_resolved') {
      excludedGroupIds.forEach((id) => combined.add(id));
    }
    return combined;
  }, [serverSkippedIds, excludedGroupIds, jobStatus]);
  const totalGroups = pipelineItems.length;
  const activeGroupsCount = Math.max(totalGroups - effectiveSkippedIds.size, 0);
  const skippedGroupCount = Math.min(effectiveSkippedIds.size, totalGroups);
  const selectedGroupCount = activeGroupsCount;
  const uploadedCount = previewSummary?.total ?? job?.original_filenames?.length ?? uploadImages.length;
  const pipelineIdSet = useMemo(() => new Set(pipelineItems.map((item) => item.id)), [pipelineItems]);
  const hdrReadyStatuses = new Set(['preprocess_ok', 'hdr_ok', 'ai_ok']);
  const isHdrReady = (item: PipelineGroupItem) => Boolean(item.hdr_url) || hdrReadyStatuses.has(item.status);
  const isOutputReady = (item: PipelineGroupItem) => Boolean(item.output_url) || item.status === 'ai_ok';
  const hdrReadyCount = pipelineItems.filter((item) => (
    !effectiveSkippedIds.has(item.id) && (isHdrReady(item) || item.status === 'failed')
  )).length;
  const hdrProgressValue = activeGroupsCount ? Math.round((hdrReadyCount / activeGroupsCount) * 100) : 0;
  const hdrProcessing = activeGroupsCount > 0 && hdrReadyCount < activeGroupsCount && processingActive;

  const mapPipelineItem = (item: PipelineGroupItem): GalleryItem => {
    const streamIndex = Math.max((item.group_index ?? 1) - 1, 0);
    const streamImage = images[streamIndex];
    const outputOverride = streamImage?.status === 'ready' ? streamImage.url : null;
    const outputReady = Boolean(outputOverride) || isOutputReady(item);
    const isSkipped = effectiveSkippedIds.has(item.id) || item.status === 'skipped' || item.is_skipped;
    const groupType = item.group_type ?? null;
    const preview = outputOverride || item.output_url || item.hdr_url || item.preview_url || '';
    const stage: GalleryItem['stage'] = outputReady
      ? 'output'
      : isSkipped
        ? 'input'
        : item.status === 'ai_processing' || item.status === 'ai_ok'
        ? 'ai'
        : item.status === 'hdr_processing' || item.status === 'hdr_ok' || item.status === 'preprocess_ok'
          ? 'hdr'
          : 'input';
    const status: GalleryItem['status'] =
      item.status === 'failed'
        ? 'failed'
        : outputReady || isSkipped
          ? 'done'
          : 'processing';
    const progress = status === 'done' || status === 'failed' ? 100 : 0;
    return {
      id: item.id,
      label: item.output_filename || `Group ${item.group_index}`,
      preview,
      status,
      progress,
      stage,
      error: item.last_error || null,
      groupType,
      groupSize: item.group_size ?? null,
      representativeIndex: item.representative_index ?? null,
      frames: item.frames,
      isSkipped
    };
  };

  const cycleRepresentative = async (item: GalleryItem, direction: 1 | -1 = 1) => {
    if (!job || !item.frames || item.frames.length < 2) return;
    const currentIndex = Math.max(0, (item.representativeIndex ?? 1) - 1);
    const nextIndex = (currentIndex + direction + item.frames.length) % item.frames.length;
    const nextFrame = item.frames[nextIndex];
    try {
      await jobService.setGroupRepresentative(job.id, item.id, nextFrame.id);
      setPipelineItems(prev => prev.map(group => {
        if (group.id !== item.id) return group;
        return {
          ...group,
          preview_url: nextFrame.preview_url ?? group.preview_url ?? null,
          representative_index: nextFrame.order
        };
      }));
      setActiveIndex(prev => (prev !== null ? prev : null));
    } catch (err) {
      pushNotice('error', err instanceof Error ? err.message : 'Failed to update preview frame.');
    }
  };

  const showUploadPlaceholders = !hideGalleryUntilPreviewsDone && pipelineItems.length === 0 && uploadImages.length > 0;
  const galleryItems = !hideGalleryUntilPreviewsDone && pipelineItems.length > 0
    ? pipelineItems.map(mapPipelineItem)
    : showUploadPlaceholders
      ? uploadImages.map(mapUploadItem)
      : showRawPreviews
        ? uploadImages.filter((img) => !img.isRaw).map(mapUploadItem)
        : [];
  const noticeTone = notice?.type === 'error'
    ? 'border-red-500/30 bg-red-500/10 text-red-200'
    : notice?.type === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : 'border-sky-500/30 bg-sky-500/10 text-sky-200';
  const noticeBanner = notice ? (
    <div className={`glass border ${noticeTone} px-4 py-3 rounded-2xl flex items-start justify-between gap-4`}>
      <div className="text-sm leading-snug">{notice.message}</div>
      <button
        type="button"
        onClick={() => setNotice(null)}
        className="text-[10px] uppercase tracking-widest text-white/70 hover:text-white"
      >
        Close
      </button>
    </div>
  ) : null;
  const confirmDialogNode = confirmDialog ? (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={() => setConfirmDialog(null)}
    >
      <div
        className="glass w-full max-w-lg rounded-[2rem] border border-white/10 p-8 text-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-xs uppercase tracking-widest text-gray-500 mb-2">
          {confirmDialog.title || 'Confirm Action'}
        </div>
        <div className="text-lg font-semibold mb-4">{confirmDialog.message}</div>
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={() => setConfirmDialog(null)}
            className="px-5 py-2 rounded-full bg-white/10 text-white text-xs font-bold uppercase tracking-widest"
          >
            {confirmDialog.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => {
              const action = confirmDialog.onConfirm;
              setConfirmDialog(null);
              action();
            }}
            className="px-5 py-2 rounded-full bg-red-500 text-white text-xs font-bold uppercase tracking-widest"
          >
            {confirmDialog.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  useEffect(() => {
    if (galleryItems.length === 0) {
      if (activeIndex !== null) setActiveIndex(null);
      return;
    }
    if (pendingActiveIndex !== null) {
      const nextIndex = Math.min(Math.max(pendingActiveIndex, 0), galleryItems.length - 1);
      setActiveIndex(nextIndex);
      setPendingActiveIndex(null);
      return;
    }
    if (activeIndex === null || activeIndex >= galleryItems.length) {
      setActiveIndex(0);
    }
  }, [galleryItems.length, activeIndex, pendingActiveIndex]);

  useEffect(() => {
    if (!showProjectInput || !activeTool) return;
    saveEditorState({
      mode: 'projects',
      workflowId: activeTool.id,
      jobId: null,
      search: projectSearch
    });
  }, [projectSearch, showProjectInput, activeTool]);

  useEffect(() => {
    if (!job?.id || showProjectInput) return;
    saveEditorState({
      mode: 'studio',
      workflowId: activeTool?.id || job.workflow_id || undefined,
      jobId: job.id,
      activeIndex
    });
  }, [activeIndex, job?.id, showProjectInput, activeTool?.id, job?.workflow_id]);

  useEffect(() => {
    if (!jobStatus || jobStatus === 'grouping') return;
    if (runpodQueue) setRunpodQueue(null);
  }, [jobStatus]);

  // VIEW 1: Tool Selector
  if (!activeTool) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] px-8 py-12">
        <div className="max-w-7xl mx-auto mb-12 text-center text-white">
          <h1 className="text-5xl font-black mb-2 uppercase tracking-tighter">Pro Studio Engines</h1>
          <p className="font-medium opacity-40">Professional photo enhancement workflows.</p>
        </div>
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-10">
          {workflows.map(tool => (
            <div key={tool.id} className="glass rounded-[2.5rem] p-8 flex flex-col group transition-all hover:scale-[1.01] border border-white/5">
              <div className="aspect-[3/2] mb-6 rounded-2xl overflow-hidden bg-black/40">
                {tool.preview_original && tool.preview_processed ? (
                  <ComparisonSlider original={tool.preview_original} processed={tool.preview_processed} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-700 font-bold uppercase tracking-widest text-[10px]">Preview Not Available</div>
                )}
              </div>
              <h3 className="text-2xl font-black text-white mb-2 uppercase tracking-tight">{tool.display_name}</h3>
              <p className="text-sm text-gray-500 mb-8 line-clamp-2">{tool.description}</p>
              <div className="mt-auto flex items-center justify-between pt-6 border-t border-white/5">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-black text-indigo-400">{tool.credit_per_unit}</span>
                  <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Pts</span>
                </div>
                <button onClick={() => handleSelectTool(tool)} className="gradient-btn text-white px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg">Open Engine</button>
              </div>
            </div>
          ))}
        </div>
        {confirmDialogNode}
      </div>
    );
  }

  // VIEW 2: Project List
  if (showProjectInput) {
    const toolHistory = activeTool ? history.filter(item => item.workflow_id === activeTool.id || item.tool_id === activeTool.id) : [];
    const filteredHistory = projectSearch.trim().length === 0
      ? toolHistory
      : toolHistory.filter(item => (item.project_name || '').toLowerCase().includes(projectSearch.toLowerCase()));
    const hasMoreHistory = history.length < historyCount;

    const getStatusBadge = (status: string) => {
      if (status === 'completed') return 'bg-green-500/20 text-green-200';
      if (status === 'partial') return 'bg-amber-500/20 text-amber-200';
      if (status === 'failed') return 'bg-red-500/20 text-red-200';
      if (status === 'draft') return 'bg-white/10 text-gray-300';
      return 'bg-white/10 text-gray-300';
    };

    return (
      <div className="min-h-screen bg-[#0a0a0a] px-8 py-12">
        <div className="max-w-6xl mx-auto space-y-8">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            <div className="flex items-center gap-3">
              <button onClick={() => { setActiveTool(null); setShowProjectInput(false); setShowNewProjectForm(false); setProjectSearch(''); setUploadComplete(false); resetStreamState(); clearEditorState(); }} className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-gray-400">
                <i className="fa-solid fa-arrow-left"></i>
              </button>
              <div>
                <div className="text-sm text-gray-500 uppercase tracking-widest">Projects</div>
                <div className="text-2xl font-black text-white">{activeTool?.display_name}</div>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm"
                placeholder="Search projects..."
              />
              <button
                onClick={() => setShowNewProjectForm(true)}
                className="px-6 py-3 rounded-2xl bg-indigo-500 text-white text-xs font-black uppercase tracking-widest"
              >
                + New Project
              </button>
            </div>
          </div>
          {noticeBanner}

          {showNewProjectForm && (
            <div className="glass w-full p-8 rounded-[2.5rem] border border-white/10 shadow-2xl">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-black uppercase tracking-tight">Create New Project</h2>
                  <p className="text-gray-500 text-sm">Enter the property address to begin.</p>
                </div>
                <button onClick={() => setShowNewProjectForm(false)} className="text-xs text-gray-500 hover:text-white">Close</button>
              </div>
              <form onSubmit={handleProjectCreate} className="flex flex-col lg:flex-row gap-4">
                <input
                  type="text"
                  required
                  className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-5 py-4 focus:outline-none focus:border-indigo-500"
                  placeholder="e.g., 123 Main St, Vancouver, BC"
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                />
                <button className="px-8 py-4 gradient-btn rounded-2xl font-black uppercase tracking-widest text-white shadow-lg active:scale-95 transition">
                  Create Project
                </button>
              </form>
            </div>
          )}

          <div className="glass w-full p-6 rounded-[2.5rem] border border-white/10 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Project List</h3>
              {historyLoading && <span className="text-[10px] text-gray-600 uppercase tracking-widest">Loading...</span>}
            </div>
            {historyError && (
              <div className="text-sm text-red-400 mb-4">Failed to load projects: {historyError}</div>
            )}
            {!historyLoading && filteredHistory.length === 0 && (
              <div className="text-sm text-gray-500 glass p-6 rounded-2xl border border-white/5">
                No projects yet for this tool.
              </div>
            )}
            {filteredHistory.length > 0 && (
              <div className="space-y-3">
                <div className="grid grid-cols-[minmax(200px,1fr)_120px_90px_120px_180px] gap-3 text-[10px] uppercase tracking-widest text-gray-500 px-2">
                  <div>Listing</div>
                  <div>Status</div>
                  <div>Photos</div>
                  <div>Created</div>
                  <div>Actions</div>
                </div>
                {filteredHistory.map((item) => {
                  const photoCount = item.original_filenames?.length ?? item.estimated_units ?? 0;
                  return (
                    <div key={item.id} className="grid grid-cols-[minmax(200px,1fr)_120px_90px_120px_180px] gap-3 items-center px-2 py-3 border border-white/5 rounded-2xl">
                      <div>
                        <div className="text-sm font-semibold text-white">{item.project_name || 'Untitled Project'}</div>
                        <div className="text-[10px] text-gray-600 uppercase tracking-widest mt-1">
                          {item.workflows?.display_name || activeTool?.display_name}
                        </div>
                      </div>
                      <div>
                        <span className={`px-3 py-1 rounded-full text-[10px] uppercase tracking-widest ${getStatusBadge(item.status)}`}>
                          {item.status}
                        </span>
                      </div>
                      <div className="text-sm text-gray-300">{photoCount}</div>
                      <div className="text-xs text-gray-400">{formatDate(item.created_at)}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        {(item.status === 'completed' || item.status === 'partial') && (
                          <button
                            onClick={async () => {
                            const { url } = await jobService.getPresignedDownloadUrl(item.id);
                            if (url) window.location.href = url;
                            }}
                            className="px-3 py-2 rounded-xl bg-green-500 text-white text-[10px] font-black uppercase tracking-widest"
                          >
                            Download
                          </button>
                        )}
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            openExistingJob(item);
                          }}
                          className="px-3 py-2 rounded-xl bg-white/10 text-white text-[10px] font-black uppercase tracking-widest hover:bg-white/20 transition"
                        >
                          Open
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            requestDeleteJob(item);
                          }}
                          className="px-3 py-2 rounded-xl bg-red-500/20 text-red-200 text-[10px] font-black uppercase tracking-widest hover:bg-red-500/30 transition"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {hasMoreHistory && (
              <div className="mt-6">
                <button
                  onClick={() => loadHistory(historyPage + 1)}
                  className="px-6 py-2 rounded-full border border-white/10 text-xs text-gray-300 hover:bg-white/5 transition"
                >
                  Load More
                </button>
              </div>
            )}
          </div>
        </div>
        {confirmDialogNode}
      </div>
    );
  }

  // VIEW 3: Main Uploader & Editor
  const showGeneratingPreviews = !showUploadOnly && previewInProgress && pipelineItems.length === 0 && uploadImages.length === 0;
  const showWaitingForResults = !showUploadOnly && !showGeneratingPreviews && galleryItems.length === 0 && pipelineStages.has(jobStatus);
  const showEmptyDropzone = !showUploadOnly && !showWaitingForResults && !showGeneratingPreviews && galleryItems.length === 0 && uploadImages.length === 0;
  const hasHiddenUploads = uploadImages.length > 0 && galleryItems.length === 0 && showRawPreviews;
  const showHdrProgress = !showUploadOnly && hdrProcessing;
  const canEnhance = jobStatus === 'input_resolved' && !hasPendingUploads && selectedGroupCount > 0;
  const canUploadBatch = hasPendingUploads && ['idle', 'draft', 'uploaded', 'analyzing', 'input_resolved', 'failed', 'partial', 'completed', 'canceled'].includes(jobStatus);
  const canAddMore = ['idle', 'draft', 'uploaded', 'analyzing', 'input_resolved'].includes(jobStatus);
  const downloadLabel = downloadType === 'jpg' ? 'Download JPG' : 'Download ZIP';
  const showReadyToEnhanceNotice = uploadComplete && jobStatus === 'input_resolved' && !processingActive;
  const showProcessingNotice = uploadComplete && (processingActive || previewInProgress || jobStatus === 'analyzing');
  const runpodEtaMinutes = runpodQueue ? Math.ceil(runpodQueue.etaSeconds / 60) : null;
  const handleGallerySelect = (item: GalleryItem, index: number) => {
    setActiveIndex(index);
    if (item.preview) {
      setLightboxUrl(item.preview);
    }
  };
  return (
    <div className="h-[calc(100vh-80px)] flex flex-col bg-[#050505]">
      <div className="glass border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => { setActiveTool(null); setUploadImages([]); setJob(null); setJobStatus('idle'); setProjectName(''); setPipelineItems([]); setPipelineProgress(null); setLightboxUrl(null); setShowProjectInput(false); setShowNewProjectForm(false); setProjectSearch(''); setUploadComplete(false); resetStreamState(); clearEditorState(); localStorage.removeItem('mvai:last_job'); }} className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-gray-400">
            <i className="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <h2 className="font-bold text-white text-sm uppercase">{projectName}</h2>
            <div className="flex items-center gap-2">
              <p className="text-[9px] text-indigo-400 font-black tracking-widest uppercase">{jobStatus}</p>
              <span className="text-[9px] text-gray-600 font-bold">| Balance: {user.points} Pts</span>
              {jobStatus === 'uploading' && uploadImages.length > 0 && (
                <span className="text-[9px] text-gray-400 font-bold">
                  | {isFinalizingUpload ? 'Finalizing upload' : `Upload ${displayUploadProgress}%`}
                </span>
              )}
              {uploadComplete && jobStatus !== 'uploading' && (
                <span className="text-[9px] text-emerald-400 font-bold">| Upload Complete</span>
              )}
              {previewInProgress && (
                <span className="text-[9px] text-rose-300 font-bold">| Previews {previewReady}/{previewTotal}</span>
              )}
              {showHdrProgress && (
                <span className="text-[9px] text-gray-400 font-bold">| HDR {hdrProgressValue}%</span>
              )}
              {runpodQueue && jobStatus === 'grouping' && (
                <span className="text-[9px] text-amber-300 font-bold">
                  | RunPod Queue {runpodQueue.pending}{runpodEtaMinutes !== null ? ` (~${runpodEtaMinutes}m)` : ''}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-1 text-[10px] uppercase tracking-widest text-gray-500">
              <span className="text-gray-400">Photos: <span className="text-white">{uploadedCount}</span></span>
              <span className="text-gray-400">Groups: <span className="text-white">{totalGroups}</span></span>
              <span className="text-gray-400">RunPod Queue: <span className="text-emerald-300">{selectedGroupCount}</span></span>
              {skippedGroupCount > 0 && (
                <span className="text-gray-400">Skipped: <span className="text-amber-300">{skippedGroupCount}</span></span>
              )}
            </div>
            {(jobStatus === 'uploading' || showHdrProgress) && (
              <div className="mt-2 h-1.5 w-48 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{ width: `${jobStatus === 'uploading' ? displayUploadProgress : hdrProgressValue}%` }}
                ></div>
              </div>
            )}
            {showProcessingNotice && (
              <div className="mt-2 text-[10px] text-emerald-300 uppercase tracking-widest">
                Upload complete. RunPod HDR/AI is running (typically under 10 minutes). You can close this page while we finish.
              </div>
            )}
            {showReadyToEnhanceNotice && (
              <div className="mt-2 text-[10px] text-gray-400 uppercase tracking-widest">
                Upload complete. Review groups and deselect any mis-grouped shots, then click Enhance to start processing.
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {(jobStatus === 'completed' || jobStatus === 'partial') && (
            <button onClick={() => { if(zipUrl) window.location.href = zipUrl }} className="px-8 py-2.5 rounded-full bg-green-500 text-white text-xs font-black uppercase tracking-widest flex items-center gap-2">
              {downloadLabel} <i className="fa-solid fa-file-zipper"></i>
            </button>
          )}
          {job?.workflow_id && (jobStatus === 'partial' || jobStatus === 'failed') && (
            <button onClick={handleRetryMissing} className="px-6 py-2.5 rounded-full bg-white/10 text-white text-xs font-black uppercase tracking-widest flex items-center gap-2">
              Retry Missing <i className="fa-solid fa-rotate-right"></i>
            </button>
          )}
          <button
            onClick={canEnhance ? startEnhanceProcess : startBatchProcess}
            disabled={!canEnhance && !canUploadBatch}
            className="px-8 py-2.5 rounded-full bg-indigo-500 text-white text-xs font-black uppercase tracking-widest disabled:opacity-30 flex items-center gap-2 transition"
          >
            {canEnhance ? 'Enhance Listing' : canUploadBatch ? 'Generate Previews' : 'Processing...'}
            <i className="fa-solid fa-bolt-lightning"></i>
          </button>
        </div>
      </div>
      {noticeBanner && (
        <div className="px-6 pt-4">
          {noticeBanner}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-8">
        {showUploadOnly ? (
          <div className="flex flex-col items-center justify-center glass rounded-[3rem] border border-white/5 min-h-[480px]">
            <div className="w-full max-w-md text-center space-y-4">
              <div className="text-lg font-black uppercase tracking-widest text-white">Uploading</div>
              <div className="text-xs text-gray-500">
                {isFinalizingUpload ? 'Finalizing upload…' : `Uploading ${uploadImages.length} files...`}
              </div>
              <div className="text-[10px] text-gray-500 uppercase tracking-widest">
                Please keep this page open until upload finishes.
              </div>
              <div className="w-full bg-white/10 h-2 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${displayUploadProgress}%` }}></div>
              </div>
              <div className="text-xs text-gray-400">{displayUploadProgress}%</div>
            </div>
          </div>
        ) : showGeneratingPreviews ? (
          <div className="flex flex-col items-center justify-center glass rounded-[3rem] border border-white/5 min-h-[480px]">
            <div className="text-center space-y-4">
              <div className="w-10 h-10 rounded-full bg-rose-500/15 text-rose-300 flex items-center justify-center mx-auto">
                <i className="fa-solid fa-image"></i>
              </div>
              <div className="text-2xl font-black tracking-tight text-white">Generating previews...</div>
              <div className="text-sm text-gray-400">{previewReady} of {previewTotal} files processed</div>
              <div className="w-64 bg-white/10 h-2 rounded-full overflow-hidden mx-auto">
                <div className="h-full bg-rose-400 transition-all" style={{ width: `${previewProgress}%` }}></div>
              </div>
            </div>
          </div>
        ) : showWaitingForResults ? (
          <div className="flex flex-col items-center justify-center glass rounded-[3rem] border border-white/5 min-h-[480px]">
            <div className="text-center space-y-3">
              <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto"></div>
              <div className="text-sm text-gray-300 uppercase tracking-widest">
                {showHdrProgress ? 'Processing HDR' : 'Processing AI'}
              </div>
              <div className="text-xs text-gray-500">
                {showHdrProgress ? 'HDR results will appear as they complete.' : 'AI results will appear as they complete.'}
              </div>
              {showHdrProgress && (
                <div className="w-64 bg-white/10 h-2 rounded-full overflow-hidden mx-auto mt-2">
                  <div className="h-full bg-indigo-500 transition-all" style={{ width: `${hdrProgressValue}%` }}></div>
                </div>
              )}
              {showProcessingNotice && (
                <div className="text-[10px] text-emerald-300 uppercase tracking-widest">
                  Upload complete. You can close this page while we finish.
                </div>
              )}
            </div>
          </div>
        ) : showEmptyDropzone ? (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center glass rounded-[3rem] border-dashed border-2 transition-colors min-h-[520px] ${isDragging ? 'border-indigo-500 bg-indigo-500/10' : 'border-white/5'}`}
          >
            <div className="text-center">
              <i className="fa-solid fa-cloud-arrow-up text-4xl text-indigo-500 mb-6"></i>
              <h3 className="text-2xl font-black text-white uppercase tracking-tighter">Drop your photos here</h3>
              <p className="text-gray-500 text-sm mt-2">or</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 px-6 py-2 bg-white/10 text-white font-bold rounded-lg hover:bg-white/20 transition-colors"
              >
                Browse Files
              </button>
              <p className="text-xs text-gray-600 mt-6 font-mono">SUPPORTED: RAW, JPG, PNG</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {hasHiddenUploads && (
              <div className="text-xs text-gray-500 border border-white/10 rounded-2xl p-4">
                RAW files uploaded. Generate previews to continue.
              </div>
            )}
            {previewInProgress && galleryItems.length > 0 && (
              <div className="text-xs text-gray-400 uppercase tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse"></span>
                Generating previews… {previewReady} of {previewTotal} processed
              </div>
            )}
            {pipelineItems.length > 0 && (
              <div className="text-[10px] uppercase tracking-widest text-gray-400 flex flex-wrap items-center gap-2">
                <span className="text-white font-black">{selectedGroupCount}</span>
                <span>of {totalGroups} groups will go to RunPod HDR.</span>
                {jobStatus === 'input_resolved' && (
                  <span className="text-gray-500">Uncheck any mis-grouped stacks before submitting.</span>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-6">
              {galleryItems.map((img, idx) => {
                const groupSize = img.groupSize ?? 0;
                const repIndex = img.representativeIndex ?? 1;
                const showBadge = groupSize > 1;
                const fromPipeline = pipelineIdSet.has(img.id);
                const isExcluded = effectiveSkippedIds.has(img.id);
                const canToggleSkip = fromPipeline && jobStatus === 'input_resolved';
                const showCheck = img.status === 'done' && !isExcluded;
                return (
                  <div
                    key={img.id || idx}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleGallerySelect(img, idx)}
                    className={`relative overflow-hidden rounded-2xl border transition-all bg-black/40 ${activeIndex === idx ? 'border-indigo-500 shadow-lg shadow-indigo-500/20' : 'border-white/5 hover:border-white/15'}`}
                  >
                    {img.preview ? (
                      <img src={img.preview} className="w-full h-48 object-cover" />
                    ) : (
                      <div className="w-full h-48 flex flex-col items-center justify-center text-[10px] text-gray-500 uppercase tracking-widest">
                        <i className="fa-solid fa-image text-lg mb-2 text-gray-600"></i>
                        Preview Pending
                      </div>
                    )}
                    {showBadge && (
                      <div className="absolute top-3 left-3 flex items-center gap-2">
                        <div className="px-2.5 py-1 rounded-full bg-black/70 text-[10px] text-white font-bold tracking-widest border border-white/10">
                          {repIndex}/{groupSize}
                        </div>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            cycleRepresentative(img, 1);
                          }}
                          className="w-7 h-7 rounded-full bg-black/70 text-[10px] text-white flex items-center justify-center border border-white/10 hover:border-white/30"
                          title="Next frame"
                        >
                          <i className="fa-solid fa-chevron-right"></i>
                        </button>
                      </div>
                    )}
                    {img.stage === 'input' && !img.preview && img.status !== 'failed' && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <p className="text-indigo-200 text-[10px] font-bold uppercase tracking-widest">
                          Preview pending
                        </p>
                      </div>
                    )}
                    {img.status === 'processing' && (img.stage === 'hdr' || img.stage === 'ai') && (
                      <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                        <p className="text-indigo-200 text-[10px] font-bold uppercase tracking-widest">
                          {img.stage === 'hdr'
                            ? 'HDR Processing'
                            : img.stage === 'ai'
                              ? 'AI Processing'
                              : 'Processing'}
                        </p>
                      </div>
                    )}
                    {img.status === 'failed' && img.error && img.stage !== 'input' && (
                      <div className="absolute inset-x-0 bottom-0 bg-red-500/30 text-red-100 text-[10px] px-3 py-2 flex items-center justify-between gap-3">
                        <span className="truncate">{img.error}</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleRetryMissing();
                          }}
                          className="px-2 py-1 rounded-full bg-white/10 text-[9px] uppercase tracking-widest text-white hover:bg-white/20"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    <div className="absolute bottom-3 left-3 right-3 text-[10px] uppercase tracking-widest text-white drop-shadow-sm">
                      {img.label}
                    </div>
                    <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
                      {fromPipeline && (
                        <button
                          type="button"
                          disabled={!canToggleSkip}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!canToggleSkip) return;
                            toggleGroupExclusion(img.id);
                          }}
                          className={`px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-widest transition ${
                            isExcluded
                              ? 'bg-amber-500/30 border-amber-400 text-amber-100'
                              : 'bg-black/60 border-white/10 text-white/80 hover:border-white/40'
                          } ${!canToggleSkip ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                          {isExcluded ? 'Skipped' : 'RunPod HDR'}
                        </button>
                      )}
                      {showCheck && (
                        <div className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] shadow">
                          <i className="fa-solid fa-check"></i>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {canAddMore && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-48 rounded-2xl border-2 border-dashed border-white/10 text-xs uppercase tracking-widest text-gray-500 flex flex-col items-center justify-center hover:border-indigo-500 hover:text-indigo-300 transition"
                >
                  <i className="fa-solid fa-plus mb-2"></i>
                  Add Photos
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {lightboxUrl && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6"
          onClick={() => setLightboxUrl(null)}
        >
          <div className="relative max-w-6xl w-full h-full flex items-center justify-center">
            <img src={lightboxUrl} className="max-h-full max-w-full object-contain rounded-2xl shadow-2xl" />
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
      )}
      {confirmDialogNode}
      <input type="file" multiple className="hidden" ref={fileInputRef} accept="image/*,.raw,.arw,.cr2,.nef" onChange={handleFileChange} />
    </div>
  );
};
export default Editor;
