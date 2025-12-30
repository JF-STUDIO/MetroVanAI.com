
import React, { useEffect, useState } from 'react';
import { jobService } from '../services/jobService';
import { Workflow } from '../types';

interface HomeProps {
  onStart: () => void;
}

const Home: React.FC<HomeProps> = ({ onStart }) => {
  const [trialPoints, setTrialPoints] = useState<number>(10);
  const [publicWorkflows, setPublicWorkflows] = useState<Workflow[]>([]);

  useEffect(() => {
    let mounted = true;
    jobService.getSettings()
      .then((data) => {
        const value = Number(data?.free_trial_points);
        if (mounted && Number.isFinite(value)) {
          setTrialPoints(value);
        }
      })
      .catch(() => {
        // Keep default if settings cannot load.
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    jobService.getPublicWorkflows()
      .then((data) => {
        if (mounted && Array.isArray(data)) {
          setPublicWorkflows(data);
        }
      })
      .catch(() => {
        // Keep empty if workflows cannot load.
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 pt-20 pb-40">
      <div className="text-center mb-24">
        <span className="px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-medium mb-6 inline-block uppercase tracking-widest">
          Capture • Refine • Succeed
        </span>
        <h1 className="text-6xl md:text-8xl font-black mb-8 tracking-tighter leading-none">
          FLAWLESS SHOTS <br />
          <span className="gradient-text">READY FAST.</span>
        </h1>
        <p className="text-xl text-gray-400 max-w-3xl mx-auto mb-12 leading-relaxed">
          Stop waiting days for retouched photos. Metrovan AI is engineered for real estate professionals 
          to transform property images into high-end, listing-ready masterpieces quickly. 
          No manual back-and-forth—just premium results every time.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <button 
            onClick={onStart}
            className="px-10 py-5 rounded-2xl gradient-btn text-white font-bold text-lg shadow-2xl shadow-indigo-500/20 hover:scale-105 active:scale-95 transition w-full sm:w-auto"
          >
            Start Editing Now
          </button>
          <div className="flex items-center gap-2 text-gray-500 text-sm font-medium">
            <i className="fa-solid fa-check text-green-500"></i>
            {trialPoints} Free Points for New Users
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {[
          { 
            icon: 'fa-gauge-high', 
            title: 'Zero Latency', 
            desc: 'Skip the outsourced editors. Our AI engines deliver studio-grade results in the blink of an eye.' 
          },
          { 
            icon: 'fa-house-chimney-window', 
            title: 'Built for Real Estate', 
            desc: 'Specifically tuned for architectural lighting, window recovery, and spatial clarity.' 
          },
          { 
            icon: 'fa-layer-group', 
            title: 'Batch Efficiency', 
            desc: 'Process entire property folders at once. Maintain consistent style across every room.' 
          }
        ].map((feat, i) => (
          <div key={i} className="glass p-8 rounded-3xl hover:border-white/20 transition group border border-white/5">
            <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center mb-6 group-hover:bg-indigo-500/20 transition">
              <i className={`fa-solid ${feat.icon} text-2xl text-indigo-400`}></i>
            </div>
            <h3 className="text-xl font-bold mb-3 uppercase tracking-tight">{feat.title}</h3>
            <p className="text-gray-400 leading-relaxed text-sm">{feat.desc}</p>
          </div>
        ))}
      </div>

      {publicWorkflows.length > 0 && (
        <div className="mt-24">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-black mb-3 uppercase tracking-tight">Featured Workflows</h2>
            <p className="text-gray-500 max-w-2xl mx-auto text-sm">
              Explore the editing styles available in Metrovan AI. Results shown are previews only.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {publicWorkflows.map((workflow) => (
              <div key={workflow.id} className="glass rounded-[2.5rem] p-6 border border-white/10">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-2xl overflow-hidden bg-white/5 border border-white/10 aspect-[4/3] flex items-center justify-center">
                    {workflow.preview_original ? (
                      <img
                        src={workflow.preview_original}
                        alt={`${workflow.display_name} before`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="text-xs text-gray-500 uppercase tracking-widest">Before</div>
                    )}
                  </div>
                  <div className="rounded-2xl overflow-hidden bg-white/5 border border-white/10 aspect-[4/3] flex items-center justify-center">
                    {workflow.preview_processed ? (
                      <img
                        src={workflow.preview_processed}
                        alt={`${workflow.display_name} after`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="text-xs text-gray-500 uppercase tracking-widest">After</div>
                    )}
                  </div>
                </div>
                <div className="mt-5">
                  <div className="text-lg font-bold">{workflow.display_name}</div>
                  {workflow.description && (
                    <p className="text-sm text-gray-500 mt-2">{workflow.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default Home;
