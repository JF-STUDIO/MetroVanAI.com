import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { jobService } from '../services/jobService';
import { Workflow } from '../types';

interface HomeProps {
  onStart: () => void;
}

const Home: React.FC<HomeProps> = ({ onStart }) => {
  const [trialPoints, setTrialPoints] = useState<number>(10);
  const [publicWorkflows, setPublicWorkflows] = useState<Workflow[]>([]);
  const navigate = useNavigate();

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

  const heroWorkflow = publicWorkflows[0];
  const steps = [
    {
      step: '01',
      title: 'Upload',
      copy: 'Drop RAW or JPG brackets. EXIF is read automatically and previews start fast.',
      icon: 'fa-cloud-arrow-up'
    },
    {
      step: '02',
      title: 'Auto Group',
      copy: 'Bracketed shots are grouped in seconds. Review and fine-tune if needed.',
      icon: 'fa-layer-group'
    },
    {
      step: '03',
      title: 'Enhance + Deliver',
      copy: 'HDR and AI workflow runs in the background. Download when ready.',
      icon: 'fa-wand-magic-sparkles'
    }
  ];

  return (
    <div className="max-w-6xl mx-auto px-6 pt-16 pb-32">
      <section className="grid lg:grid-cols-[1.1fr,0.9fr] gap-12 items-center">
        <div className="space-y-8">
          <span className="pill">Architectural AI Studio</span>
          <h1 className="headline-font text-5xl md:text-7xl leading-tight">
            Make every listing <span className="gradient-text">look premium</span> in minutes.
          </h1>
          <p className="text-lg text-slate-600 leading-relaxed">
            Metrovan AI turns bracketed property shoots into clean HDR and polished AI edits with a
            single workflow. Upload once, approve fast, deliver instantly.
          </p>
          <div className="flex flex-col sm:flex-row gap-4">
            <button
              onClick={onStart}
              className="btn-primary px-8 py-4 rounded-full text-sm font-semibold"
            >
              Start in Studio
            </button>
            <button
              onClick={() => navigate('/pricing')}
              className="btn-secondary px-8 py-4 rounded-full text-sm font-semibold"
            >
              View Pricing
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
            <span className="balance-pill">{trialPoints} free credits</span>
            <span>No setup fees. Upgrade only when you need more volume.</span>
          </div>
        </div>

        <div className="apple-card p-6 rise-in" style={{ animationDelay: '0.15s' }}>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl overflow-hidden bg-slate-100 aspect-[4/3] flex items-center justify-center">
              {heroWorkflow?.preview_original ? (
                <img
                  src={heroWorkflow.preview_original}
                  alt={`${heroWorkflow.display_name} before`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-xs text-slate-500 uppercase tracking-widest">Before</div>
              )}
            </div>
            <div className="rounded-2xl overflow-hidden bg-slate-100 aspect-[4/3] flex items-center justify-center">
              {heroWorkflow?.preview_processed ? (
                <img
                  src={heroWorkflow.preview_processed}
                  alt={`${heroWorkflow.display_name} after`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-xs text-slate-500 uppercase tracking-widest">After</div>
              )}
            </div>
          </div>
          <div className="mt-6 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Workflow</div>
              <div className="text-lg font-semibold text-slate-900">
                {heroWorkflow?.display_name || 'Auto HDR + AI'}
              </div>
              <div className="text-sm text-slate-500">Optimized for listing-ready delivery.</div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Avg. delivery</div>
              <div className="text-2xl font-semibold text-slate-900">8 min</div>
              <div className="text-xs text-slate-500">Per group</div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-20 grid md:grid-cols-3 gap-6">
        {steps.map((item, index) => (
          <div
            key={item.step}
            className="step-card rise-in"
            style={{ animationDelay: `${0.1 + index * 0.1}s` }}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Step {item.step}</span>
              <i className={`fa-solid ${item.icon} text-slate-700`}></i>
            </div>
            <h3 className="mt-4 text-xl font-semibold text-slate-900">{item.title}</h3>
            <p className="mt-2 text-sm text-slate-500">{item.copy}</p>
          </div>
        ))}
      </section>

      {publicWorkflows.length > 0 && (
        <section className="mt-24">
          <div className="text-center mb-12">
            <h2 className="headline-font text-3xl md:text-4xl mb-3">Featured workflows</h2>
            <p className="text-slate-500 max-w-2xl mx-auto text-sm">
              Preview the look and feel of each workflow before you run a full batch.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {publicWorkflows.map((workflow, index) => (
              <div
                key={workflow.id}
                className="apple-card p-6 rise-in"
                style={{ animationDelay: `${0.1 + index * 0.08}s` }}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-2xl overflow-hidden bg-slate-100 aspect-[4/3] flex items-center justify-center">
                    {workflow.preview_original ? (
                      <img
                        src={workflow.preview_original}
                        alt={`${workflow.display_name} before`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="text-xs text-slate-500 uppercase tracking-widest">Before</div>
                    )}
                  </div>
                  <div className="rounded-2xl overflow-hidden bg-slate-100 aspect-[4/3] flex items-center justify-center">
                    {workflow.preview_processed ? (
                      <img
                        src={workflow.preview_processed}
                        alt={`${workflow.display_name} after`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="text-xs text-slate-500 uppercase tracking-widest">After</div>
                    )}
                  </div>
                </div>
                <div className="mt-5">
                  <div className="text-lg font-semibold text-slate-900">{workflow.display_name}</div>
                  {workflow.description && (
                    <p className="text-sm text-slate-500 mt-2">{workflow.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-24 apple-card p-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-8">
        <div>
          <h3 className="headline-font text-3xl text-slate-900 mb-3">
            Deliver listings faster with Metrovan AI.
          </h3>
          <p className="text-slate-500 max-w-2xl">
            Built for busy teams who need consistent results without long turnaround times or manual edits.
          </p>
        </div>
        <button onClick={onStart} className="btn-primary px-8 py-4 rounded-full text-sm font-semibold">
          Start a project
        </button>
      </section>
    </div>
  );
};

export default Home;
