import React, { useState, useRef, useEffect } from 'react';
import { PhotoTool, User } from '../types';
import { jobService } from '../services/jobService';
import axios from 'axios';

interface EditorProps {
  user: User;
  tools: PhotoTool[];
  onUpdateUser: (user: User) => void;
}

interface ImageItem {
  id: string; // assetId from server
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
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMove = (e: React.MouseEvent | React.TouchEvent) => {
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
    >
      <img src={original} className="absolute inset-0 w-full h-full object-cover" alt="Before" loading="lazy" />
      <div 
        className="absolute inset-0 w-full h-full overflow-hidden" 
        style={{ clipPath: `inset(0 0 0 ${sliderPos}%)` }}
      >
        <img src={processed} className="absolute inset-0 w-full h-full object-cover" alt="After" loading="lazy" />
      </div>
      <div 
        className="absolute top-0 bottom-0 w-0.5 bg-white/50 shadow-[0_0_15px_rgba(0,0,0,0.8)] z-10"
        style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)' }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-2xl border border-gray-200">
          <i className="fa-solid fa-arrows-left-right text-indigo-600 text-[10px]"></i>
        </div>
      </div>
    </div>
  );
};

const Editor: React.FC<EditorProps> = ({ user, tools, onUpdateUser }) => {
  const [activeTool, setActiveTool] = useState<PhotoTool | null>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>('idle'); // idle, uploading, processing, completed
  const [zipUrl, setZipUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 轮询 Job 状态
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (jobId && jobStatus === 'processing') {
      timer = setInterval(async () => {
        try {
          const job = await jobService.getJobStatus(jobId);
          setJobStatus(job.status);
          
          // 更新每个图片的状态
          setImages(prev => prev.map(img => {
              const serverAsset = job.job_assets.find((a: any) => a.id === img.id);
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

          if (job.status === 'completed') {
            clearInterval(timer);
            const { url } = await jobService.getPresignedDownloadUrl(jobId);
            setZipUrl(url);
            // 刷新积分
            const profile = await jobService.getProfile();
            onUpdateUser({ ...user, points: profile.points });
          } else if (job.status === 'failed') {
            clearInterval(timer);
          }
        } catch (err) {
          console.error('Polling error:', err);
        }
      }, 3000);
    }
    return () => clearInterval(timer);
  }, [jobId, jobStatus]);

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
    if (activeIndex === null) setActiveIndex(images.length);
  };

  const startBatchProcess = async () => {
    if (!activeTool || images.length === 0) return;

    const totalCost = images.length * activeTool.point_cost;
    if (user.points < totalCost) {
      alert(`Insufficient points! Needed: ${totalCost}, You have: ${user.points}`);
      return;
    }

    try {
      setJobStatus('uploading');
      
      const job = await jobService.createJob(activeTool.id);
      setJobId(job.id);

      const presignedData = await jobService.getPresignedUploadUrls(job.id, images.map(img => ({
        name: img.file.name,
        type: img.file.type
      })));

      const updatedImages = [...images];
      await Promise.all(presignedData.map(async (data: any, index: number) => {
        const img = updatedImages[index];
        img.id = data.assetId;
        img.status = 'uploading';
        
        await axios.put(data.putUrl, img.file, {
          headers: { 'Content-Type': img.file.type },
          onUploadProgress: (progressEvent) => {
            img.progress = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
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
                <div className="h-48 mb-6 rounded-2xl overflow-hidden bg-black/40">
                   {tool.preview_url ? <img src={tool.preview_url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-gray-700 font-bold uppercase tracking-widest text-[10px]">Preview Not Available</div>}
                </div>
                <h3 className="text-2xl font-black text-white mb-2 uppercase tracking-tight">{tool.name}</h3>
                <p className="text-sm text-gray-500 mb-8 line-clamp-2">{tool.description}</p>
                <div className="mt-auto flex items-center justify-between pt-6 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-black text-indigo-400">{tool.point_cost}</span>
                    <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Pts</span>
                  </div>
                  <button onClick={() => setActiveTool(tool)} className="gradient-btn text-white px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg">Open Engine</button>
                </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const currentImage = activeIndex !== null ? images[activeIndex] : null;

  return (
    <div className="h-[calc(100vh-80px)] flex flex-col bg-[#050505]">
      <div className="glass border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => { setActiveTool(null); setImages([]); setJobId(null); setJobStatus('idle'); }}
            className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-gray-400"
          >
            <i className="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <h2 className="font-bold text-white text-sm uppercase">{activeTool.name}</h2>
            <div className="flex items-center gap-2">
                <p className="text-[9px] text-indigo-400 font-black tracking-widest uppercase">{jobStatus}</p>
                <span className="text-[9px] text-gray-600 font-bold">| Balance: {user.points} Pts</span>
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
              disabled={images.length === 0 || jobStatus !== 'idle'}
              className="px-8 py-2.5 rounded-full bg-indigo-500 text-white text-xs font-black uppercase tracking-widest disabled:opacity-30 flex items-center gap-2 transition"
           >
             {jobStatus === 'idle' ? 'Start Batch Process' : 'Processing...'}
             <i className="fa-solid fa-bolt-lightning"></i>
           </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 p-8 flex flex-col overflow-hidden">
          {!currentImage ? (
            <div onClick={() => fileInputRef.current?.click()} className="flex-1 flex flex-col items-center justify-center glass rounded-[3rem] border-dashed border-2 border-white/5 cursor-pointer">
              <i className="fa-solid fa-upload text-3xl text-indigo-400 mb-6"></i>
              <h3 className="text-2xl font-black text-white uppercase tracking-tighter">Upload Property Photos</h3>
              <p className="text-gray-500 text-sm">RAW or JPG supported</p>
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
            <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Assets ({images.length})</h3>
            <button onClick={() => fileInputRef.current?.click()} className="text-indigo-400"><i className="fa-solid fa-plus"></i></button>
          </div>
          <div className="space-y-4">
            {images.map((img, idx) => (
              <div key={idx} onClick={() => setActiveIndex(idx)} className={`relative h-24 rounded-2xl overflow-hidden cursor-pointer border-2 ${activeIndex === idx ? 'border-indigo-500' : 'border-transparent'}`}>
                <img src={img.preview} className="w-full h-full object-cover" />
                {img.status === 'done' && <div className="absolute top-2 right-2 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center text-[10px] text-white"><i className="fa-solid fa-check"></i></div>}
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
