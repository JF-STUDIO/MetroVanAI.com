import React, { useState, useRef, useEffect } from 'react';
import { PhotoTool, User, Job } from '../types';
import { jobService } from '../services/jobService';
import axios from 'axios';

interface EditorProps {
  user: User;
  tool: PhotoTool;
  job: Job;
  onUpdateUser: (user: User) => void;
}

interface ImageItem {
  id: string; 
  file: File;
  preview: string;
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'failed';
  progress: number;
  statusText?: string;
  r2Key?: string;
  putUrl?: string;
}

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

const Editor: React.FC<EditorProps> = ({ user, tool, job, onUpdateUser }) => {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [jobStatus, setJobStatus] = useState<string>(job.status);
  const [zipUrl, setZipUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Poll for job status
  useEffect(() => {
    let timer: NodeJS.Timeout;
    
    // Initial fetch to load existing assets if returning to a job
    const fetchJobData = async () => {
        try {
            const jobData = await jobService.getJobStatus(job.id);
            setJobStatus(jobData.status);
            // Here you would typically map existing assets to images state
            // For now, we focus on status updates
            if (jobData.status === 'completed') {
                const { url } = await jobService.getPresignedDownloadUrl(job.id);
                setZipUrl(url);
            }
        } catch (error) {
            console.error("Failed to fetch job data", error);
        }
    };
    fetchJobData();

    if (jobStatus === 'processing' || jobStatus === 'pending') {
      timer = setInterval(async () => {
        try {
          const jobData = await jobService.getJobStatus(job.id);
          setJobStatus(jobData.status);
          
          // Update image statuses based on job assets
          setImages(prev => prev.map(img => {
              const serverAsset = jobData.job_assets.find((a: any) => a.id === img.id);
              if (serverAsset) {
                  return {
                      ...img,
                      status: serverAsset.status === 'processed' ? 'done' : 
                              serverAsset.status === 'failed' ? 'failed' : 'processing',
                      progress: serverAsset.status === 'processed' ? 100 : 50
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
        } catch (err) {
          console.error('Polling error:', err);
        }
      }, 3000);
    }
    return () => clearInterval(timer);
  }, [job.id, jobStatus, onUpdateUser, user]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    const newItems: ImageItem[] = files.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      file,
      preview: URL.createObjectURL(file),
      status: 'pending',
      progress: 0,
      statusText: 'Ready'
    }));

    setImages(prev => [...prev, ...newItems]);
    if (activeIndex === null && newItems.length > 0) setActiveIndex(images.length);
  };

  const startBatchProcess = async () => {
    if (images.length === 0) return;

    const totalCost = images.length * tool.point_cost;
    if (user.points < totalCost) {
      alert(`Insufficient points! Needed: ${totalCost}, You have: ${user.points}`);
      return;
    }

    try {
      setJobStatus('uploading');
      
      // Get presigned URLs for the existing job
      const presignedData = await jobService.getPresignedUploadUrls(job.id, images.map(img => ({
        name: img.file.name,
        type: img.file.type
      })));

      const updatedImages = [...images];
      await Promise.all(presignedData.map(async (data: any, index: number) => {
        // Simple mapping assumption: presignedData order matches images order because we sent them in order. 
        // Better robustness: match by filename if possible, but index is okay for this context.
        const img = updatedImages[index]; 
        if (!img) return;

        img.id = data.assetId;
        img.status = 'uploading';
        
        await axios.put(data.putUrl, img.file, {
          headers: { 'Content-Type': img.file.type },
          onUploadProgress: (progressEvent) => {
            const total = progressEvent.total || 1;
            img.progress = Math.round((progressEvent.loaded * 100) / total);
            setImages([...updatedImages]);
          }
        });
        
        img.status = 'processing';
        img.statusText = 'Uploaded';
        setImages([...updatedImages]);
      }));

      await jobService.commitJob(job.id);
      setJobStatus('processing');

    } catch (err: any) {
      alert('Upload failed: ' + err.message);
      setJobStatus('idle');
    }
  };

  const downloadZip = () => {
    if (zipUrl) window.location.href = zipUrl;
  };

  const currentImage = activeIndex !== null ? images[activeIndex] : null;

  return (
    <div className="h-[calc(100vh-80px)] flex flex-col bg-[#050505]">
      <div className="glass border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => window.location.reload()} // Simple way to go back to list for now, or pass a handler
            className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          >
            <i className="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <h2 className="font-bold text-white text-sm uppercase">{job.project_name || 'Untitled Project'}</h2>
            <div className="flex items-center gap-2">
                <p className="text-[9px] text-indigo-400 font-black tracking-widest uppercase">{jobStatus}</p>
                <span className="text-[9px] text-gray-600 font-bold">| {tool.name}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
           {jobStatus === 'completed' && (
             <button onClick={downloadZip} className="px-8 py-2.5 rounded-full bg-green-500 text-white text-xs font-black uppercase tracking-widest flex items-center gap-2">
                Download ZIP <i className="fa-solid fa-file-zipper"></i>
             </button>
           )}
           <button 
              onClick={startBatchProcess}
              disabled={images.length === 0 || (jobStatus !== 'idle' && jobStatus !== 'pending')}
              className="px-8 py-2.5 rounded-full bg-indigo-500 text-white text-xs font-black uppercase tracking-widest disabled:opacity-30 flex items-center gap-2 transition"
           >
             {jobStatus === 'idle' || jobStatus === 'pending' ? 'Start Batch Process' : 'Processing...'}
             <i className="fa-solid fa-bolt-lightning"></i>
           </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 p-8 flex flex-col overflow-hidden">
          {!currentImage ? (
            <div onClick={() => fileInputRef.current?.click()} className="flex-1 flex flex-col items-center justify-center glass rounded-[3rem] border-dashed border-2 border-white/5 cursor-pointer hover:bg-white/5 transition-colors">
              <i className="fa-solid fa-cloud-arrow-up text-4xl text-indigo-500 mb-6"></i>
              <h3 className="text-2xl font-black text-white uppercase tracking-tighter">Upload Photos</h3>
              <p className="text-gray-500 text-sm mt-2">Drag & drop or click to browse</p>
              <p className="text-xs text-gray-600 mt-4 font-mono">SUPPORTED: RAW, JPG, PNG</p>
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

      <input type="file" multiple className="hidden" ref={fileInputRef} accept="image/*" onChange={handleFileChange} />
    </div>
  );
};

export default Editor;
