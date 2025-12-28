import React, { useState, useRef, useEffect } from 'react';
import { Workflow, User, Job, JobAsset, PipelineGroupItem } from '../types';
import { jobService } from '../services/jobService';
import axios from 'axios';

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
  const [images, setImages] = useState<ImageItem[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [projectName, setProjectName] = useState('');
  const [jobStatus, setJobStatus] = useState('idle');
  const [zipUrl, setZipUrl] = useState<string | null>(null);
  const [pipelineItems, setPipelineItems] = useState<PipelineGroupItem[]>([]);
  const [pipelineProgress, setPipelineProgress] = useState<number | null>(null);
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
  const [uploadComplete, setUploadComplete] = useState(false);
  const editorStateKey = 'mvai:editor_state';
  const [pendingActiveIndex, setPendingActiveIndex] = useState<number | null>(null);
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

  // Poll for job status
  useEffect(() => {
    if (!job) return;
    if (job.workflow_id) {
      if (!pipelineStages.has(jobStatus)) return;
    } else if (!(jobStatus === 'processing' || jobStatus === 'queued')) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        if (job.workflow_id) {
          const response = await jobService.getPipelineStatus(job.id);
          const pipelineJob = response.job;
          setJob(pipelineJob);
          setJobStatus(pipelineJob.status);
          if (Array.isArray(response.items)) {
            setPipelineItems(response.items);
          }
          if (typeof response.progress === 'number') {
            setPipelineProgress(response.progress);
          }

          if (pipelineJob.status === 'completed' || pipelineJob.status === 'partial') {
            clearInterval(timer);
            const { url } = await jobService.getPresignedDownloadUrl(job.id);
            setZipUrl(url);
            const profile = await jobService.getProfile();
            onUpdateUser({ ...user, points: profile.available_credits ?? profile.points ?? 0 });
            setImages(prev => prev.map(img => ({ ...img, status: 'done', progress: 100 })));
          } else if (pipelineJob.status === 'failed') {
            clearInterval(timer);
          }
        } else {
          if (pipelineItems.length > 0) {
            setPipelineItems([]);
            setPipelineProgress(null);
          }
          const jobData = await jobService.getJobStatus(job.id);
          setJobStatus(jobData.status);

          setImages(prev => prev.map(img => {
            const serverAsset = jobData.job_assets.find((a: JobAsset) => a.id === img.id);
            if (serverAsset) {
              return {
                ...img,
                status: serverAsset.status === 'processed' ? 'done' :
                        serverAsset.status === 'failed' ? 'failed' : 'processing',
                progress: serverAsset.status === 'processed' ? 100 : 50,
              };
            }
            return img;
          }));

          if (jobData.status === 'completed') {
            clearInterval(timer);
            const { url } = await jobService.getPresignedDownloadUrl(job.id);
            setZipUrl(url);
            const profile = await jobService.getProfile();
            onUpdateUser({ ...user, points: profile.available_credits ?? profile.points ?? 0 });
          } else if (jobData.status === 'failed') {
            clearInterval(timer);
          }
        }
      } catch (err) { console.error('Polling error:', err); }
    }, 3000);

    return () => clearInterval(timer);
  }, [job, jobStatus, onUpdateUser, user]);

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

    if (editorState?.mode === 'projects' && editorState.workflowId) {
      const workflow = workflows.find(tool => tool.id === editorState?.workflowId);
      if (workflow) {
        setActiveTool(workflow);
        setShowProjectInput(true);
        setShowNewProjectForm(false);
        setProjectSearch(editorState.search || '');
        setImages([]);
        setActiveIndex(null);
        setZipUrl(null);
        setPipelineItems([]);
        setPipelineProgress(null);
        setUploadComplete(true);
      }
      setResumeAttempted(true);
      return;
    }
    const jobId = editorState?.jobId || cached?.jobId;
    const workflowId = editorState?.workflowId || cached?.workflowId;
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
    setImages([]);
    setActiveIndex(null);
    setZipUrl(null);
    setPipelineItems([]);
    setPipelineProgress(null);
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
        if (pipelineJob.status === 'completed' || pipelineJob.status === 'partial') {
          const { url } = await jobService.getPresignedDownloadUrl(pipelineJob.id);
          setZipUrl(url);
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
    setImages([]);
    setActiveIndex(null);
    setZipUrl(null);
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
        if (pipelineJob.status === 'completed' || pipelineJob.status === 'partial') {
          const { url } = await jobService.getPresignedDownloadUrl(pipelineJob.id);
          setZipUrl(url);
        }
      } else {
        setPipelineItems([]);
        setPipelineProgress(null);
        const jobData = await jobService.getJobStatus(item.id);
        setJob(jobData);
        setJobStatus(jobData.status);
        if (jobData.status === 'completed') {
          const { url } = await jobService.getPresignedDownloadUrl(jobData.id);
          setZipUrl(url);
        }
      }
    } catch (err) {
      console.error('Failed to load project:', err);
    }
  };

  const handleCancelJob = async () => {
    if (!job?.id) return;
    try {
      await jobService.cancelJob(job.id);
      setJobStatus('canceled');
      const profile = await jobService.getProfile();
      onUpdateUser({ ...user, points: profile.available_credits ?? profile.points ?? 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel job.';
      pushNotice('error', message);
    }
  };

  const deleteExistingJob = async (item: HistoryJob) => {
    try {
      await jobService.deleteJob(item.id);
      setHistory(prev => prev.filter(jobItem => jobItem.id !== item.id));
      setHistoryCount(prev => Math.max(prev - 1, 0));
      if (job?.id === item.id) {
        setJob(null);
        setImages([]);
        setJobStatus('idle');
        setProjectName('');
        setZipUrl(null);
        setPipelineItems([]);
        setPipelineProgress(null);
        localStorage.removeItem('mvai:last_job');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete project.';
      pushNotice('error', message);
    }
  };

  const requestCancelJob = () => {
    openConfirm({
      title: 'Cancel processing?',
      message: 'This will stop remaining processing and release unused credits.',
      confirmLabel: 'Cancel Job',
      onConfirm: handleCancelJob
    });
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
    const maxFiles = Number(import.meta.env.VITE_MAX_UPLOAD_FILES || 0);
    const maxFileBytes = Number(import.meta.env.VITE_MAX_FILE_BYTES || (200 * 1024 * 1024));
    if (maxFiles > 0 && images.length + files.length > maxFiles) {
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
    }
    setImages(prev => [...prev, ...newItems]);
    if (activeIndex === null) setActiveIndex(images.length - 1 + newItems.length);
  };

  // Handle new files from input click
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(e.target.files);
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
    if (!activeTool || images.length === 0 || !job) {
      pushNotice('error', 'Missing job details. Select a project and upload files first.');
      return;
    }

    try {
      setNotice(null);
      setJobStatus('uploading');
      setUploadComplete(false);
      setPipelineItems([]);
      setPipelineProgress(null);
      const presignedData: { r2Key: string; putUrl: string; fileName: string }[] = await jobService.getPresignedRawUploadUrls(
        job.id,
        images.map(img => ({ name: img.file.name, type: img.file.type || 'application/octet-stream', size: img.file.size }))
      );

      const uploadedFiles: { r2_key: string; filename: string }[] = [];
      await Promise.all(images.map(async (img) => {
        const presignInfo = presignedData.find((p) => p.fileName === img.file.name);
        if (!presignInfo) return;

        img.status = 'uploading';
        await axios.put(presignInfo.putUrl, img.file, {
          headers: { 'Content-Type': img.file.type || 'application/octet-stream' },
          onUploadProgress: (progressEvent) => {
            const total = progressEvent.total || 1;
            img.progress = Math.round((progressEvent.loaded * 100) / total);
            setImages(prev => [...prev]);
          }
        });

        uploadedFiles.push({ r2_key: presignInfo.r2Key, filename: img.file.name });
        img.status = 'processing';
        img.statusText = 'Uploaded';
        img.progress = 100;
        setImages(prev => [...prev]);
      }));

      await jobService.uploadComplete(job.id, uploadedFiles);
      setUploadComplete(true);
      const analysis = await jobService.analyzeJob(job.id);
      const estimatedUnits = analysis?.estimated_units || 0;

      const profile = await jobService.getProfile();
      const availableCredits = profile.available_credits ?? profile.points ?? 0;
      const totalCost = estimatedUnits * activeTool.credit_per_unit;
      if (availableCredits < totalCost) {
        onUpdateUser({ ...user, points: availableCredits });
        setJobStatus('uploaded');
        pushNotice('error', `Insufficient credits. Needed: ${totalCost}, You have: ${availableCredits}`);
        return;
      }

      const startResponse = await jobService.startJob(job.id);
      setJobStatus('reserved');
      const balanceRow = Array.isArray(startResponse?.balance) ? startResponse.balance[0] : startResponse?.balance;
      const nextAvailable = balanceRow?.available_credits ?? (availableCredits - totalCost);
      onUpdateUser({ ...user, points: nextAvailable });
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

  // UI Flow Handlers
  const handleSelectTool = (tool: Workflow) => {
    setActiveTool(tool);
    setShowProjectInput(true);
    setShowNewProjectForm(false);
    setProjectSearch('');
    setPipelineItems([]);
    setPipelineProgress(null);
    setLightboxUrl(null);
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
      setLightboxUrl(null);
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

  const mapUploadItem = (item: ImageItem): GalleryItem => ({
    id: item.id,
    label: item.file.name,
    preview: item.preview,
    status: item.status,
    progress: item.progress,
    stage: 'input'
  });

  const showRawPreviews = jobStatus === 'idle' || jobStatus === 'draft' || jobStatus === 'uploaded';
  const showUploadOnly = jobStatus === 'uploading';

  const uploadProgress = images.length
    ? Math.round(images.reduce((sum, img) => sum + img.progress, 0) / images.length)
    : 0;

  const pipelineProgressValue = typeof pipelineProgress === 'number'
    ? pipelineProgress
    : typeof job?.progress === 'number'
      ? job.progress
      : null;

  const hdrReadyStatuses = new Set(['preprocess_ok', 'hdr_ok', 'ai_ok']);
  const isHdrReady = (item: PipelineGroupItem) => Boolean(item.hdr_url) || hdrReadyStatuses.has(item.status);
  const isOutputReady = (item: PipelineGroupItem) => Boolean(item.output_url) || item.status === 'ai_ok';
  const totalGroups = pipelineItems.length;
  const hdrReadyCount = pipelineItems.filter((item) => isHdrReady(item) || item.status === 'failed').length;
  const hdrProgressValue = totalGroups ? Math.round((hdrReadyCount / totalGroups) * 100) : 0;
  const hdrProcessing = totalGroups > 0 && hdrReadyCount < totalGroups && pipelineStages.has(jobStatus);

  const mapPipelineItem = (item: PipelineGroupItem): GalleryItem => {
    const outputReady = isOutputReady(item);
    const hdrReady = isHdrReady(item);
    const preview = item.output_url || item.hdr_url || '';
    const status: GalleryItem['status'] =
      item.status === 'failed' ? 'failed' : outputReady ? 'done' : 'processing';
    const stage: GalleryItem['stage'] = outputReady ? 'output' : hdrReady ? 'ai' : 'hdr';
    const progress = status === 'done'
      ? 100
      : status === 'failed'
        ? 100
        : stage === 'hdr'
          ? Math.max(5, Math.min(90, hdrProgressValue || 35))
          : Math.max(10, Math.min(95, pipelineProgressValue ?? 70));
    return {
      id: item.id,
      label: item.output_filename || `Group ${item.group_index}`,
      preview,
      status,
      progress,
      stage,
      error: item.last_error || null
    };
  };

  const galleryItems = pipelineItems.length > 0
    ? pipelineItems.filter((item) => item.output_url || item.hdr_url || item.status === 'failed').map(mapPipelineItem)
    : showRawPreviews
      ? images.filter((img) => !img.isRaw).map(mapUploadItem)
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

  // VIEW 1: Tool Selector
  if (!activeTool) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] px-8 py-12">
        <div className="max-w-7xl mx-auto mb-12 text-center text-white">
          <h1 className="text-5xl font-black mb-2 uppercase tracking-tighter">Pro Studio Engines</h1>
          <p className="font-medium opacity-40">Batch processing with R2 & RunningHub</p>
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
              <button onClick={() => { setActiveTool(null); setShowProjectInput(false); setShowNewProjectForm(false); setProjectSearch(''); setUploadComplete(false); clearEditorState(); }} className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-gray-400">
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
                          onClick={() => openExistingJob(item)}
                          className="px-3 py-2 rounded-xl bg-white/10 text-white text-[10px] font-black uppercase tracking-widest hover:bg-white/20 transition"
                        >
                          Open
                        </button>
                        <button
                          onClick={() => requestDeleteJob(item)}
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
      </div>
    );
  }

  // VIEW 3: Main Uploader & Editor
  const currentImage = activeIndex !== null ? galleryItems[activeIndex] : null;
  const cancelableStatuses = new Set([
    'reserved',
    'input_resolved',
    'preprocessing',
    'hdr_processing',
    'workflow_running',
    'ai_processing',
    'postprocess',
    'packaging',
    'zipping',
    'processing',
    'queued'
  ]);
  const canCancel = job?.id && cancelableStatuses.has(jobStatus);
  const showWaitingForResults = !showUploadOnly && galleryItems.length === 0 && pipelineStages.has(jobStatus);
  const showEmptyDropzone = !showUploadOnly && !showWaitingForResults && !currentImage && images.length === 0;
  const hasHiddenUploads = images.length > 0 && galleryItems.length === 0 && showRawPreviews;
  const showAiProgress = !showUploadOnly && pipelineStages.has(jobStatus) && !hdrProcessing && pipelineProgressValue !== null;
  const showHdrProgress = !showUploadOnly && hdrProcessing;
  return (
    <div className="h-[calc(100vh-80px)] flex flex-col bg-[#050505]">
      <div className="glass border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => { setActiveTool(null); setImages([]); setJob(null); setJobStatus('idle'); setProjectName(''); setPipelineItems([]); setPipelineProgress(null); setLightboxUrl(null); setShowProjectInput(false); setShowNewProjectForm(false); setProjectSearch(''); setUploadComplete(false); clearEditorState(); localStorage.removeItem('mvai:last_job'); }} className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-gray-400">
            <i className="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <h2 className="font-bold text-white text-sm uppercase">{projectName}</h2>
            <div className="flex items-center gap-2">
              <p className="text-[9px] text-indigo-400 font-black tracking-widest uppercase">{jobStatus}</p>
              <span className="text-[9px] text-gray-600 font-bold">| Balance: {user.points} Pts</span>
              {jobStatus === 'uploading' && images.length > 0 && (
                <span className="text-[9px] text-gray-400 font-bold">| Upload {uploadProgress}%</span>
              )}
              {uploadComplete && jobStatus !== 'uploading' && (
                <span className="text-[9px] text-emerald-400 font-bold">| Upload Complete</span>
              )}
              {showHdrProgress && (
                <span className="text-[9px] text-gray-400 font-bold">| HDR {hdrProgressValue}%</span>
              )}
              {showAiProgress && (
                <span className="text-[9px] text-gray-400 font-bold">| AI {pipelineProgressValue}%</span>
              )}
            </div>
            {(jobStatus === 'uploading' || showHdrProgress || showAiProgress) && (
              <div className="mt-2 h-1.5 w-48 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{ width: `${jobStatus === 'uploading' ? uploadProgress : showHdrProgress ? hdrProgressValue : pipelineProgressValue || 0}%` }}
                ></div>
              </div>
            )}
            {uploadComplete && jobStatus !== 'uploading' && (
              <div className="mt-2 text-[10px] text-emerald-300 uppercase tracking-widest">
                Upload complete. You can close this page while we finish processing.
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {(jobStatus === 'completed' || jobStatus === 'partial') && (
            <button onClick={() => { if(zipUrl) window.location.href = zipUrl }} className="px-8 py-2.5 rounded-full bg-green-500 text-white text-xs font-black uppercase tracking-widest flex items-center gap-2">
              Download ZIP <i className="fa-solid fa-file-zipper"></i>
            </button>
          )}
          {job?.workflow_id && (jobStatus === 'partial' || jobStatus === 'failed') && (
            <button onClick={handleRetryMissing} className="px-6 py-2.5 rounded-full bg-white/10 text-white text-xs font-black uppercase tracking-widest flex items-center gap-2">
              Retry Missing <i className="fa-solid fa-rotate-right"></i>
            </button>
          )}
          {canCancel && (
            <button onClick={requestCancelJob} className="px-6 py-2.5 rounded-full bg-red-500/20 text-red-200 text-xs font-black uppercase tracking-widest flex items-center gap-2 hover:bg-red-500/30 transition">
              Cancel Processing <i className="fa-solid fa-ban"></i>
            </button>
          )}
          <button
            onClick={startBatchProcess}
            disabled={images.length === 0 || !['idle', 'draft', 'uploaded'].includes(jobStatus)}
            className="px-8 py-2.5 rounded-full bg-indigo-500 text-white text-xs font-black uppercase tracking-widest disabled:opacity-30 flex items-center gap-2 transition"
          >
            {['idle', 'draft', 'uploaded'].includes(jobStatus) ? 'Start Batch Process' : 'Processing...'}
            <i className="fa-solid fa-bolt-lightning"></i>
          </button>
        </div>
      </div>
      {noticeBanner && (
        <div className="px-6 pt-4">
          {noticeBanner}
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 p-8 flex flex-col overflow-hidden">
          {showUploadOnly ? (
            <div className="flex-1 flex flex-col items-center justify-center glass rounded-[3rem] border border-white/5">
              <div className="w-full max-w-md text-center space-y-4">
                <div className="text-lg font-black uppercase tracking-widest text-white">Uploading</div>
                <div className="text-xs text-gray-500">Uploading {images.length} files...</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-widest">
                  Please keep this page open until upload finishes.
                </div>
                <div className="w-full bg-white/10 h-2 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all" style={{ width: `${uploadProgress}%` }}></div>
                </div>
                <div className="text-xs text-gray-400">{uploadProgress}%</div>
              </div>
            </div>
          ) : showWaitingForResults ? (
            <div className="flex-1 flex flex-col items-center justify-center glass rounded-[3rem] border border-white/5">
              <div className="text-center space-y-3">
                <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto"></div>
                <div className="text-sm text-gray-300 uppercase tracking-widest">
                  {showHdrProgress ? 'Processing HDR' : 'Processing AI'}
                </div>
                <div className="text-xs text-gray-500">
                  {showHdrProgress ? 'HDR previews will appear here as they complete.' : 'AI results will appear here as they complete.'}
                </div>
                {showHdrProgress && (
                  <div className="w-64 bg-white/10 h-2 rounded-full overflow-hidden mx-auto mt-2">
                    <div className="h-full bg-indigo-500 transition-all" style={{ width: `${hdrProgressValue}%` }}></div>
                  </div>
                )}
                {uploadComplete && (
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
              className={`flex-1 flex flex-col items-center justify-center glass rounded-[3rem] border-dashed border-2 transition-colors ${isDragging ? 'border-indigo-500 bg-indigo-500/10' : 'border-white/5'}`}
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
            <div className="flex-1 relative glass rounded-[3rem] overflow-hidden bg-black border border-white/5">
              {currentImage?.preview ? (
                <button
                  type="button"
                  onClick={() => setLightboxUrl(currentImage.preview || null)}
                  className="w-full h-full"
                >
                  <img src={currentImage.preview} className="w-full h-full object-contain p-6" />
                </button>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-gray-500 uppercase tracking-widest text-center px-6">
                  {hasHiddenUploads ? 'RAW files uploaded. Start processing to generate HDR previews.' : 'Waiting for preview'}
                </div>
              )}
              {currentImage?.label && (
                <div className="absolute top-4 left-4 px-3 py-1 rounded-full bg-black/60 text-[10px] text-white uppercase tracking-widest">
                  {currentImage.label}
                </div>
              )}
              {currentImage?.status && currentImage.status !== 'pending' && currentImage.status !== 'done' && (
                <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center">
                  <div className="w-64 bg-white/10 h-1.5 rounded-full overflow-hidden mb-4">
                    <div className="h-full bg-indigo-500 transition-all" style={{ width: `${currentImage.progress}%` }}></div>
                  </div>
                  <p className="text-indigo-400 font-black text-[10px] uppercase tracking-widest">
                    {currentImage.stage === 'hdr'
                      ? 'HDR Processing'
                      : currentImage.stage === 'ai'
                        ? 'AI Processing'
                        : currentImage.stage === 'output'
                          ? 'Processed'
                          : currentImage.status}
                  </p>
                </div>
              )}
              {currentImage?.stage && currentImage.status !== 'failed' && (
                <div className="absolute bottom-4 left-4 px-3 py-1 rounded-full bg-black/70 text-[10px] text-white uppercase tracking-widest">
                  {currentImage.stage === 'hdr' ? 'HDR' : currentImage.stage === 'ai' ? 'AI' : currentImage.stage === 'output' ? 'Done' : 'Input'}
                </div>
              )}
              {currentImage?.status === 'failed' && currentImage.error && (
                <div className="absolute bottom-4 left-4 right-4 text-[10px] text-red-300 bg-black/60 px-3 py-2 rounded-xl">
                  {currentImage.error}
                </div>
              )}
            </div>
          )}
        </div>
        <aside className="w-80 glass border-l border-white/5 p-6 overflow-y-auto">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Project Assets</h3>
            <button onClick={() => fileInputRef.current?.click()} className="text-indigo-400 hover:text-indigo-300 transition-colors"><i className="fa-solid fa-plus-circle text-lg"></i></button>
          </div>
          <div className="space-y-4">
            {showUploadOnly && (
              <div className="text-xs text-gray-500 border border-white/10 rounded-2xl p-4">
                Uploading {images.length} files...
              </div>
            )}
            {!showUploadOnly && galleryItems.length === 0 && (
              <div className="text-xs text-gray-500 border border-white/10 rounded-2xl p-4">
                {hasHiddenUploads ? 'RAW files uploaded. Start processing to see previews.' : 'Waiting for results...'}
              </div>
            )}
            {!showUploadOnly && galleryItems.map((img, idx) => (
              <div key={img.id || idx} onClick={() => setActiveIndex(idx)} className={`relative h-24 rounded-2xl overflow-hidden cursor-pointer border-2 transition-all ${activeIndex === idx ? 'border-indigo-500 shadow-lg shadow-indigo-500/20' : 'border-transparent hover:border-white/10'}`}>
                {img.preview ? (
                  <img src={img.preview} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-600 uppercase tracking-widest bg-black/40">
                    Pending
                  </div>
                )}
                {img.status === 'done' && <div className="absolute top-2 right-2 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center text-[10px] text-white shadow-sm"><i className="fa-solid fa-check"></i></div>}
                {img.status === 'uploading' && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div></div>}
                {img.stage && (
                  <div className="absolute bottom-2 left-2 text-[9px] uppercase tracking-widest bg-black/60 text-white px-2 py-0.5 rounded-full">
                    {img.stage === 'hdr' ? 'HDR' : img.stage === 'ai' ? 'AI' : img.stage === 'output' ? 'Done' : 'Input'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>
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
      {confirmDialog && (
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
      )}
      <input type="file" multiple className="hidden" ref={fileInputRef} accept="image/*,.raw,.arw,.cr2,.nef" onChange={handleFileChange} />
    </div>
  );
};
export default Editor;
