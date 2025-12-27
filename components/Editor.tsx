import React, { useState, useRef, useEffect } from 'react';
import { PhotoTool, User, Job, JobAsset } from '../types';
import { jobService } from '../services/jobService';
import axios from 'axios';

// Props for the main component
interface EditorProps {
  user: User;
  tools: PhotoTool[];
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
}

type HistoryJob = Job & { photo_tools?: { name?: string } | null };

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
const Editor: React.FC<EditorProps> = ({ user, tools, onUpdateUser }) => {
  const [activeTool, setActiveTool] = useState<PhotoTool | null>(null);
  const [showProjectInput, setShowProjectInput] = useState(false);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [projectName, setProjectName] = useState('');
  const [jobStatus, setJobStatus] = useState('idle');
  const [zipUrl, setZipUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [history, setHistory] = useState<HistoryJob[]>([]);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Poll for job status
  useEffect(() => {
    if (!(job && (jobStatus === 'processing' || jobStatus === 'queued'))) return;

    const timer = setInterval(async () => {
      try {
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
          onUpdateUser({ ...user, points: profile.points });
        } else if (jobData.status === 'failed') {
          clearInterval(timer);
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

    try {
      const jobData = await jobService.getJobStatus(item.id);
      setJob(jobData);
      setJobStatus(jobData.status);
      if (jobData.status === 'completed') {
        const { url } = await jobService.getPresignedDownloadUrl(jobData.id);
        setZipUrl(url);
      }
    } catch (err) {
      console.error('Failed to load project:', err);
    }
  };

  // Unified file handler for both click and drop
  const processFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const newItems: ImageItem[] = files.map(file => ({
      id: Math.random().toString(36).substring(2, 9),
      file,
      preview: URL.createObjectURL(file),
      status: 'pending',
      progress: 0,
      statusText: 'Ready',
    }));
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


  // Main batch processing logic
  const startBatchProcess = async () => {
    if (!activeTool || images.length === 0 || !job) return alert('Error: Missing job details.');

    const totalCost = images.length * activeTool.point_cost;
    if (user.points < totalCost) return alert(`Insufficient points! Needed: ${totalCost}, You have: ${user.points}`);

    try {
      setJobStatus('uploading');
      const presignedData: { assetId: string, putUrl: string, fileName: string }[] = await jobService.getPresignedUploadUrls(job.id, images.map(img => ({ name: img.file.name, type: img.file.type })));
      
      await Promise.all(images.map(async (img) => {
        const presignInfo = presignedData.find((p) => p.fileName === img.file.name);
        if (!presignInfo) return;

        img.id = presignInfo.assetId;
        img.status = 'uploading';
        
        await axios.put(presignInfo.putUrl, img.file, {
          headers: { 'Content-Type': img.file.type },
          onUploadProgress: (progressEvent) => {
            const total = progressEvent.total || 1;
            img.progress = Math.round((progressEvent.loaded * 100) / total);
            setImages(prev => [...prev]);
          }
        });
        
        img.status = 'processing';
        img.statusText = 'Uploaded';
        setImages(prev => [...prev]);
      }));

      await jobService.commitJob(job.id);
      setJobStatus('processing');
    } catch (err) {
      if (err instanceof Error) {
        alert('Upload failed: ' + err.message);
      } else {
        alert('An unknown upload error occurred.');
      }
      setJobStatus('idle');
    }
  };

  // UI Flow Handlers
  const handleSelectTool = (tool: PhotoTool) => {
    setActiveTool(tool);
    setShowProjectInput(true);
  };
  
  const handleProjectCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName || !activeTool) return;
    try {
      const newJob = await jobService.createJob(activeTool.id, projectName);
      setJob(newJob);
      setJobStatus(newJob.status)
      setShowProjectInput(false);
      setHistory(prev => [{
        ...(newJob as Job),
        photo_tools: { name: activeTool.name }
      }, ...prev]);
      setHistoryCount(prev => prev + 1);
    } catch (error) {
      if (error instanceof Error) {
        alert("Failed to create project: " + error.message);
      } else {
        alert('An unknown error occurred while creating the project.');
      }
    }
  };

  // VIEW 1: Tool Selector
  if (!activeTool) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] px-8 py-12">
        <div className="max-w-7xl mx-auto mb-12 text-center text-white">
          <h1 className="text-5xl font-black mb-2 uppercase tracking-tighter">Pro Studio Engines</h1>
          <p className="font-medium opacity-40">Batch processing with R2 & RunningHub</p>
        </div>
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-10">
          {tools.map(tool => (
            <div key={tool.id} className="glass rounded-[2.5rem] p-8 flex flex-col group transition-all hover:scale-[1.01] border border-white/5">
              <div className="aspect-[3/2] mb-6 rounded-2xl overflow-hidden bg-black/40">
                {tool.preview_original && tool.preview_processed ? (
                  <ComparisonSlider original={tool.preview_original} processed={tool.preview_processed} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-700 font-bold uppercase tracking-widest text-[10px]">Preview Not Available</div>
                )}
              </div>
              <h3 className="text-2xl font-black text-white mb-2 uppercase tracking-tight">{tool.name}</h3>
              <p className="text-sm text-gray-500 mb-8 line-clamp-2">{tool.description}</p>
              <div className="mt-auto flex items-center justify-between pt-6 border-t border-white/5">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-black text-indigo-400">{tool.point_cost}</span>
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

  // VIEW 2: Project Creation Form
  if (showProjectInput) {
    const toolHistory = activeTool ? history.filter(item => item.tool_id === activeTool.id) : [];
    const hasMoreHistory = history.length < historyCount;

    return (
      <div className="min-h-screen bg-[#0a0a0a] px-8 py-12">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-10">
          <div className="glass w-full p-10 rounded-[2.5rem] border border-white/10 shadow-2xl">
            <div className="text-center mb-10">
              <h2 className="text-3xl font-black mb-2 uppercase tracking-tighter">Create New Project</h2>
              <p className="text-gray-500">Enter the property address to begin.</p>
            </div>
            <form onSubmit={handleProjectCreate} className="space-y-6">
              <div>
                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-2 tracking-widest pl-1">Property Address</label>
                <input type="text" required className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 focus:outline-none focus:border-indigo-500" placeholder="e.g., 123 Main St, Vancouver, BC" value={projectName} onChange={e => setProjectName(e.target.value)} />
              </div>
              <button className="w-full py-4 gradient-btn rounded-2xl font-black uppercase tracking-widest text-white shadow-lg active:scale-95 transition">Create Project</button>
            </form>
             <button onClick={() => { setActiveTool(null); setShowProjectInput(false); }} className="w-full mt-4 text-xs text-gray-500 hover:text-white">Cancel</button>
          </div>
          <div className="glass w-full p-10 rounded-[2.5rem] border border-white/10 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Existing Projects</h3>
              {historyLoading && <span className="text-[10px] text-gray-600 uppercase tracking-widest">Loading...</span>}
            </div>
            {historyError && (
              <div className="text-sm text-red-400 mb-4">Failed to load projects: {historyError}</div>
            )}
            {!historyLoading && toolHistory.length === 0 && (
              <div className="text-sm text-gray-500 glass p-6 rounded-2xl border border-white/5">
                No projects yet for this tool.
              </div>
            )}
            {toolHistory.length > 0 && (
              <div className="space-y-4">
                {toolHistory.map((item) => (
                  <div key={item.id} className="p-4 rounded-2xl border border-white/5 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-white">{item.project_name || 'Untitled Project'}</div>
                      <div className="text-[10px] text-gray-600 uppercase tracking-widest mt-1">
                        {item.status} | {formatDate(item.created_at)}
                      </div>
                    </div>
                    {item.status === 'completed' ? (
                      <button
                        onClick={async () => {
                          const { url } = await jobService.getPresignedDownloadUrl(item.id);
                          if (url) window.location.href = url;
                        }}
                        className="px-4 py-2 rounded-xl bg-green-500 text-white text-[10px] font-black uppercase tracking-widest"
                      >
                        Download ZIP
                      </button>
                    ) : (
                      <button
                        onClick={() => openExistingJob(item)}
                        className="px-4 py-2 rounded-xl bg-white/10 text-white text-[10px] font-black uppercase tracking-widest hover:bg-white/20 transition"
                      >
                        Open Project
                      </button>
                    )}
                  </div>
                ))}
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
  const currentImage = activeIndex !== null ? images[activeIndex] : null;
  return (
    <div className="h-[calc(100vh-80px)] flex flex-col bg-[#050505]">
      <div className="glass border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => { setActiveTool(null); setImages([]); setJob(null); setJobStatus('idle'); setProjectName(''); }} className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-gray-400">
            <i className="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <h2 className="font-bold text-white text-sm uppercase">{projectName}</h2>
            <div className="flex items-center gap-2">
              <p className="text-[9px] text-indigo-400 font-black tracking-widest uppercase">{jobStatus}</p>
              <span className="text-[9px] text-gray-600 font-bold">| Balance: {user.points} Pts</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {jobStatus === 'completed' && (<button onClick={() => { if(zipUrl) window.location.href = zipUrl }} className="px-8 py-2.5 rounded-full bg-green-500 text-white text-xs font-black uppercase tracking-widest flex items-center gap-2">Download ZIP <i className="fa-solid fa-file-zipper"></i></button>)}
          <button onClick={startBatchProcess} disabled={images.length === 0 || (jobStatus !== 'idle' && jobStatus !== 'pending')} className="px-8 py-2.5 rounded-full bg-indigo-500 text-white text-xs font-black uppercase tracking-widest disabled:opacity-30 flex items-center gap-2 transition">
            {jobStatus === 'idle' || jobStatus === 'pending' ? 'Start Batch Process' : 'Processing...'}
            <i className="fa-solid fa-bolt-lightning"></i>
          </button>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 p-8 flex flex-col overflow-hidden">
          {!currentImage ? (
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
              <img src={currentImage.preview} className="w-full h-full object-contain p-6" />
              {currentImage.status !== 'pending' && currentImage.status !== 'done' && (
                <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center">
                  <div className="w-64 bg-white/10 h-1.5 rounded-full overflow-hidden mb-4">
                    <div className="h-full bg-indigo-500 transition-all" style={{ width: `${currentImage.progress}%` }}></div>
                  </div>
                  <p className="text-indigo-400 font-black text-[10px] uppercase tracking-widest">{currentImage.status}</p>
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
            {images.map((img, idx) => (
              <div key={idx} onClick={() => setActiveIndex(idx)} className={`relative h-24 rounded-2xl overflow-hidden cursor-pointer border-2 transition-all ${activeIndex === idx ? 'border-indigo-500 shadow-lg shadow-indigo-500/20' : 'border-transparent hover:border-white/10'}`}>
                <img src={img.preview} className="w-full h-full object-cover" />
                {img.status === 'done' && <div className="absolute top-2 right-2 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center text-[10px] text-white shadow-sm"><i className="fa-solid fa-check"></i></div>}
                {img.status === 'uploading' && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div></div>}
              </div>
            ))}
          </div>
        </aside>
      </div>
      <input type="file" multiple className="hidden" ref={fileInputRef} accept="image/*,.raw,.arw,.cr2,.nef" onChange={handleFileChange} />
    </div>
  );
};
export default Editor;
