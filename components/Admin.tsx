import React, { useEffect, useState } from 'react';
import { AdminJobRow, AdminWorkflow, AppSettings, CreditRow, User, WorkflowVersion } from '../types';
import { jobService } from '../services/jobService';

type NewWorkflowForm = {
  slug: string;
  display_name: string;
  description: string;
  credit_per_unit: string;
  is_active: boolean;
  is_hidden: boolean;
  sort_order: string;
  preview_original: string;
  preview_processed: string;
  provider_name: string;
  workflow_remote_id: string;
  input_node_key: string;
  input_node_id: string;
  output_node_id: string;
  api_mode: string;
  runtime_config: string;
};

type VersionDraft = {
  workflow_remote_id: string;
  input_node_key: string;
  input_node_id: string;
  output_node_id: string;
  api_mode: string;
  runtime_config: string;
  notes: string;
  is_published: boolean;
};

type CreditDraft = {
  delta: string;
  note: string;
};

const DEFAULT_INPUT_NODE = 'image';
const DEFAULT_INPUT_NODE_ID = '31';
const DEFAULT_OUTPUT_NODE_ID = '57';
const DEFAULT_API_MODE = 'task_openapi';

const parseRuntimeConfig = (value: string) => {
  if (!value || value.trim().length === 0) return undefined;
  return JSON.parse(value);
};

const buildRuntimeConfigText = (runtimeConfig?: Record<string, unknown> | null) => {
  if (!runtimeConfig) return '';
  const cleaned = { ...runtimeConfig } as Record<string, unknown>;
  delete cleaned.input_node_key;
  delete cleaned.input_node_id;
  delete cleaned.output_node_id;
  delete cleaned.api_mode;
  const keys = Object.keys(cleaned);
  if (keys.length === 0) return '';
  return JSON.stringify(cleaned, null, 2);
};

const buildDraftFromWorkflow = (workflow?: AdminWorkflow | null): VersionDraft => {
  const runtimeConfig = workflow?.published_version?.runtime_config as Record<string, unknown> | undefined;
  return {
    workflow_remote_id: workflow?.published_version?.workflow_remote_id || '',
    input_node_key: (runtimeConfig?.input_node_key as string | undefined) || DEFAULT_INPUT_NODE,
    input_node_id: runtimeConfig?.input_node_id ? String(runtimeConfig.input_node_id) : DEFAULT_INPUT_NODE_ID,
    output_node_id: runtimeConfig?.output_node_id ? String(runtimeConfig.output_node_id) : DEFAULT_OUTPUT_NODE_ID,
    api_mode: (runtimeConfig?.api_mode as string | undefined) || DEFAULT_API_MODE,
    runtime_config: buildRuntimeConfigText(runtimeConfig),
    notes: '',
    is_published: false
  };
};

const Admin: React.FC<{ user: User }> = ({ user }) => {
  const [workflows, setWorkflows] = useState<AdminWorkflow[]>([]);
  const [versionsByWorkflow, setVersionsByWorkflow] = useState<Record<string, WorkflowVersion[]>>({});
  const [credits, setCredits] = useState<CreditRow[]>([]);
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ free_trial_points: 10 });
  const [settingsDraft, setSettingsDraft] = useState('10');
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [loading, setLoading] = useState({ workflows: false, credits: false, jobs: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newWorkflow, setNewWorkflow] = useState<NewWorkflowForm>({
    slug: '',
    display_name: '',
    description: '',
    credit_per_unit: '1',
    is_active: true,
    is_hidden: false,
    sort_order: '0',
    preview_original: '',
    preview_processed: '',
    provider_name: 'runninghub_ai',
    workflow_remote_id: '',
    input_node_key: DEFAULT_INPUT_NODE,
    input_node_id: DEFAULT_INPUT_NODE_ID,
    output_node_id: DEFAULT_OUTPUT_NODE_ID,
    api_mode: DEFAULT_API_MODE,
    runtime_config: ''
  });
  const [versionDrafts, setVersionDrafts] = useState<Record<string, VersionDraft>>({});
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, any>>({});
  const [creditDrafts, setCreditDrafts] = useState<Record<string, CreditDraft>>({});
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<string | null>(null);

  const loadWorkflows = async () => {
    setLoading(prev => ({ ...prev, workflows: true }));
    setError(null);
    try {
      const data = await jobService.adminGetWorkflows();
      setWorkflows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows.');
    } finally {
      setLoading(prev => ({ ...prev, workflows: false }));
    }
  };

  const loadCredits = async () => {
    setLoading(prev => ({ ...prev, credits: true }));
    setError(null);
    try {
      const data = await jobService.adminGetCredits();
      setCredits(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credits.');
    } finally {
      setLoading(prev => ({ ...prev, credits: false }));
    }
  };

  const loadJobs = async () => {
    setLoading(prev => ({ ...prev, jobs: true }));
    setError(null);
    try {
      const data = await jobService.adminGetJobs(50);
      setJobs(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs.');
    } finally {
      setLoading(prev => ({ ...prev, jobs: false }));
    }
  };

  const loadSettings = async () => {
    setSettingsLoading(true);
    setError(null);
    try {
      const data = await jobService.adminGetSettings();
      const value = Number(data?.free_trial_points ?? 10);
      const next = Number.isFinite(value) ? value : 10;
      setSettings({ free_trial_points: next });
      setSettingsDraft(String(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings.');
    } finally {
      setSettingsLoading(false);
    }
  };

  useEffect(() => {
    if (user.isAdmin) {
      loadWorkflows();
      loadCredits();
      loadJobs();
      loadSettings();
    }
  }, [user.isAdmin]);

  const updateWorkflowField = (id: string, field: keyof AdminWorkflow, value: any) => {
    setWorkflows(prev => prev.map(workflow => (
      workflow.id === id ? { ...workflow, [field]: value } : workflow
    )));
  };

  const handleQuickToggleHidden = async (workflow: AdminWorkflow) => {
    setNotice(null);
    setError(null);
    try {
      const nextHidden = !(workflow.is_hidden ?? false);
      const updated = await jobService.adminUpdateWorkflow(workflow.id, { is_hidden: nextHidden });
      setWorkflows(prev => prev.map(item => (item.id === workflow.id ? { ...item, ...updated } : item)));
      setNotice(nextHidden ? 'Workflow hidden.' : 'Workflow visible.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update workflow.');
    }
  };

  const handleSortBump = async (workflow: AdminWorkflow, delta: number) => {
    setNotice(null);
    setError(null);
    try {
      const current = Number(workflow.sort_order) || 0;
      const nextOrder = current + delta;
      const updated = await jobService.adminUpdateWorkflow(workflow.id, { sort_order: nextOrder });
      setWorkflows(prev => prev.map(item => (item.id === workflow.id ? { ...item, ...updated } : item)));
      setNotice('Sort order updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update sort order.');
    }
  };

  const handleCreateWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setError(null);
    try {
      const runtimeConfig = parseRuntimeConfig(newWorkflow.runtime_config) || {};
      if (newWorkflow.api_mode) runtimeConfig.api_mode = newWorkflow.api_mode;
      if (newWorkflow.input_node_key) runtimeConfig.input_node_key = newWorkflow.input_node_key.trim();
      if (newWorkflow.input_node_id) runtimeConfig.input_node_id = newWorkflow.input_node_id.trim();
      if (newWorkflow.output_node_id) runtimeConfig.output_node_id = newWorkflow.output_node_id.trim();
      const payload: Record<string, unknown> = {
        slug: newWorkflow.slug.trim(),
        display_name: newWorkflow.display_name.trim(),
        description: newWorkflow.description.trim() || null,
        credit_per_unit: Number(newWorkflow.credit_per_unit) || 1,
        is_active: newWorkflow.is_active,
        is_hidden: newWorkflow.is_hidden,
        sort_order: Number(newWorkflow.sort_order) || 0,
        preview_original: newWorkflow.preview_original.trim() || null,
        preview_processed: newWorkflow.preview_processed.trim() || null,
        provider_name: newWorkflow.provider_name,
        workflow_remote_id: newWorkflow.workflow_remote_id.trim() || undefined,
        input_node_key: newWorkflow.input_node_key.trim() || DEFAULT_INPUT_NODE,
        runtime_config: runtimeConfig
      };

      const created = await jobService.adminCreateWorkflow(payload);
      setWorkflows(prev => [created, ...prev]);
      setNewWorkflow({
        slug: '',
        display_name: '',
        description: '',
        credit_per_unit: '1',
        is_active: true,
        is_hidden: false,
        sort_order: '0',
        preview_original: '',
        preview_processed: '',
        provider_name: newWorkflow.provider_name,
        workflow_remote_id: '',
        input_node_key: DEFAULT_INPUT_NODE,
        input_node_id: DEFAULT_INPUT_NODE_ID,
        output_node_id: DEFAULT_OUTPUT_NODE_ID,
        api_mode: DEFAULT_API_MODE,
        runtime_config: ''
      });
      setNotice('Workflow created.');
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('runtime_config must be valid JSON.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create workflow.');
      }
    }
  };

  const handleSaveWorkflow = async (workflow: AdminWorkflow) => {
    setNotice(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        display_name: workflow.display_name,
        description: workflow.description || null,
        credit_per_unit: Number(workflow.credit_per_unit) || 1,
        is_active: workflow.is_active ?? true,
        is_hidden: workflow.is_hidden ?? false,
        sort_order: Number(workflow.sort_order) || 0,
        preview_original: workflow.preview_original || null,
        preview_processed: workflow.preview_processed || null,
        provider_name: workflow.provider_name || undefined
      };
      const updated = await jobService.adminUpdateWorkflow(workflow.id, payload);
      setWorkflows(prev => prev.map(item => (item.id === workflow.id ? { ...item, ...updated } : item)));
      setNotice('Workflow updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update workflow.');
    }
  };

  const handleLoadVersions = async (workflowId: string) => {
    setNotice(null);
    setError(null);
    try {
      const data = await jobService.adminGetVersions(workflowId);
      setVersionsByWorkflow(prev => ({ ...prev, [workflowId]: Array.isArray(data) ? data : [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load versions.');
    }
  };

  const handleCreateVersion = async (workflowId: string) => {
    setNotice(null);
    setError(null);
    const draft = versionDrafts[workflowId];
    if (!draft?.workflow_remote_id) {
      setError('workflow_remote_id is required.');
      return;
    }
    try {
      const runtimeConfig = parseRuntimeConfig(draft.runtime_config) || {};
      if (draft.api_mode) runtimeConfig.api_mode = draft.api_mode;
      if (draft.input_node_key) runtimeConfig.input_node_key = draft.input_node_key;
      if (draft.input_node_id) runtimeConfig.input_node_id = draft.input_node_id;
      if (draft.output_node_id) runtimeConfig.output_node_id = draft.output_node_id;
      const payload = {
        workflow_remote_id: draft.workflow_remote_id.trim(),
        runtime_config: runtimeConfig,
        notes: draft.notes || null,
        is_published: draft.is_published
      };
      await jobService.adminCreateVersion(workflowId, payload);
      await handleLoadVersions(workflowId);
      setVersionDrafts(prev => ({
        ...prev,
        [workflowId]: {
          workflow_remote_id: '',
          input_node_key: DEFAULT_INPUT_NODE,
          input_node_id: DEFAULT_INPUT_NODE_ID,
          output_node_id: DEFAULT_OUTPUT_NODE_ID,
          api_mode: DEFAULT_API_MODE,
          runtime_config: '',
          notes: '',
          is_published: false
        }
      }));
      setNotice('Version created.');
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('runtime_config must be valid JSON.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create version.');
      }
    }
  };

  const handleUpdateVersion = async (workflowId: string, versionId?: string | null) => {
    if (!versionId) {
      setError('No published version to update.');
      return;
    }
    setNotice(null);
    setError(null);
    const draft = versionDrafts[workflowId];
    if (!draft?.workflow_remote_id) {
      setError('workflow_remote_id is required.');
      return;
    }
    try {
      const runtimeConfig = parseRuntimeConfig(draft.runtime_config) || {};
      if (draft.api_mode) runtimeConfig.api_mode = draft.api_mode;
      if (draft.input_node_key) runtimeConfig.input_node_key = draft.input_node_key;
      if (draft.input_node_id) runtimeConfig.input_node_id = draft.input_node_id;
      if (draft.output_node_id) runtimeConfig.output_node_id = draft.output_node_id;
      const payload = {
        workflow_remote_id: draft.workflow_remote_id.trim(),
        runtime_config: runtimeConfig,
        notes: draft.notes || null
      };
      await jobService.adminUpdateVersion(workflowId, versionId, payload);
      await handleLoadVersions(workflowId);
      await loadWorkflows();
      setNotice('Version updated.');
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('runtime_config must be valid JSON.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to update version.');
      }
    }
  };

  const handlePublishVersion = async (workflowId: string, versionId: string) => {
    setNotice(null);
    setError(null);
    try {
      await jobService.adminPublishVersion(workflowId, versionId);
      await handleLoadVersions(workflowId);
      await loadWorkflows();
      setNotice('Version published.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish version.');
    }
  };

  const handleTestRun = async (workflowId: string) => {
    const inputUrl = testInputs[workflowId];
    if (!inputUrl) {
      setError('input_url is required for test-run.');
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const result = await jobService.adminTestRun(workflowId, { input_url: inputUrl });
      setTestResults(prev => ({ ...prev, [workflowId]: result }));
      setNotice('Test-run completed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run test.');
    }
  };

  const handleAdjustCredits = async (row: CreditRow) => {
    const draft = creditDrafts[row.user_id];
    if (!draft?.delta) return;
    setNotice(null);
    setError(null);
    try {
      const delta = Number(draft.delta);
      if (!Number.isInteger(delta)) {
        setError('Delta must be an integer.');
        return;
      }
      await jobService.adminAdjustCredits({
        user_id: row.user_id,
        delta,
        note: draft.note || null
      });
      await loadCredits();
      setNotice('Credits updated.');
      setCreditDrafts(prev => ({ ...prev, [row.user_id]: { delta: '', note: '' } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to adjust credits.');
    }
  };

  const handleUpdateSettings = async () => {
    setNotice(null);
    setError(null);
    const nextValue = Number(settingsDraft);
    if (!Number.isFinite(nextValue) || nextValue < 0) {
      setError('Free trial points must be a non-negative number.');
      return;
    }
    try {
      const updated = await jobService.adminUpdateSettings({ free_trial_points: nextValue });
      const value = Number(updated?.free_trial_points ?? nextValue);
      setSettings({ free_trial_points: Number.isFinite(value) ? value : nextValue });
      setSettingsDraft(String(Number.isFinite(value) ? value : nextValue));
      setNotice('Settings updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update settings.');
    }
  };

  if (!user.isAdmin) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] px-8 py-12 text-white">
        <div className="max-w-4xl mx-auto glass rounded-[2.5rem] p-10 border border-white/10">
          Admin access required.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] px-8 py-12 text-white">
      <div className="max-w-6xl mx-auto space-y-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight">Admin Console</h1>
            <p className="text-sm text-gray-500">Manage workflows, versions, and credits.</p>
          </div>
          <div className="flex gap-3">
            <button onClick={loadWorkflows} className="px-4 py-2 rounded-full border border-white/10 text-xs uppercase tracking-widest">Refresh Workflows</button>
            <button onClick={loadCredits} className="px-4 py-2 rounded-full border border-white/10 text-xs uppercase tracking-widest">Refresh Credits</button>
            <button onClick={loadJobs} className="px-4 py-2 rounded-full border border-white/10 text-xs uppercase tracking-widest">Refresh Jobs</button>
          </div>
        </div>

        {(error || notice) && (
          <div className="glass rounded-2xl p-4 border border-white/10 text-sm">
            {error && <div className="text-red-400">{error}</div>}
            {notice && <div className="text-emerald-400">{notice}</div>}
          </div>
        )}

        <section className="glass rounded-[2.5rem] p-8 border border-white/10">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-sm font-black uppercase tracking-widest text-gray-400">Trial Settings</h2>
              <p className="text-xs text-gray-500">Controls the free points granted to new users.</p>
            </div>
            {settingsLoading && <span className="text-xs text-gray-500">Loading...</span>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Free Trial Points</label>
              <input
                value={settingsDraft}
                onChange={(e) => setSettingsDraft(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={handleUpdateSettings}
                className="px-6 py-3 rounded-2xl gradient-btn text-white text-xs font-black uppercase tracking-widest"
              >
                Save Settings
              </button>
            </div>
          </div>
          <div className="mt-4 text-xs text-gray-500">
            Current: {settings.free_trial_points} points
          </div>
        </section>

        <section className="glass rounded-[2.5rem] p-8 border border-white/10">
          <h2 className="text-sm font-black uppercase tracking-widest text-gray-400 mb-6">Create Workflow</h2>
          <form onSubmit={handleCreateWorkflow} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Slug</label>
              <input value={newWorkflow.slug} onChange={(e) => setNewWorkflow(prev => ({ ...prev, slug: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" required />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Display Name</label>
              <input value={newWorkflow.display_name} onChange={(e) => setNewWorkflow(prev => ({ ...prev, display_name: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" required />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Credits Per Unit</label>
              <input value={newWorkflow.credit_per_unit} onChange={(e) => setNewWorkflow(prev => ({ ...prev, credit_per_unit: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Sort Order</label>
              <input value={newWorkflow.sort_order} onChange={(e) => setNewWorkflow(prev => ({ ...prev, sort_order: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Provider</label>
              <select value={newWorkflow.provider_name} onChange={(e) => setNewWorkflow(prev => ({ ...prev, provider_name: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
                <option value="runninghub_ai">runninghub_ai</option>
                <option value="runninghub_cn">runninghub_cn</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Preview Before URL</label>
              <input value={newWorkflow.preview_original} onChange={(e) => setNewWorkflow(prev => ({ ...prev, preview_original: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="https://..." />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Preview After URL</label>
              <input value={newWorkflow.preview_processed} onChange={(e) => setNewWorkflow(prev => ({ ...prev, preview_processed: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="https://..." />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Workflow Remote ID</label>
              <input value={newWorkflow.workflow_remote_id} onChange={(e) => setNewWorkflow(prev => ({ ...prev, workflow_remote_id: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Input Node Key</label>
              <input value={newWorkflow.input_node_key} onChange={(e) => setNewWorkflow(prev => ({ ...prev, input_node_key: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Input Node ID</label>
              <input value={newWorkflow.input_node_id} onChange={(e) => setNewWorkflow(prev => ({ ...prev, input_node_id: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="31" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Output Node ID</label>
              <input value={newWorkflow.output_node_id} onChange={(e) => setNewWorkflow(prev => ({ ...prev, output_node_id: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="57" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">API Mode</label>
              <select value={newWorkflow.api_mode} onChange={(e) => setNewWorkflow(prev => ({ ...prev, api_mode: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
                <option value="task_openapi">task_openapi</option>
                <option value="workflow">workflow</option>
              </select>
            </div>
            <div className="lg:col-span-2">
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Description</label>
              <textarea value={newWorkflow.description} onChange={(e) => setNewWorkflow(prev => ({ ...prev, description: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 h-24" />
            </div>
            <div className="lg:col-span-2">
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">runtime_config (JSON)</label>
              <textarea value={newWorkflow.runtime_config} onChange={(e) => setNewWorkflow(prev => ({ ...prev, runtime_config: e.target.value }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 h-24" placeholder='{"poll_interval": 4000}' />
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={newWorkflow.is_active} onChange={(e) => setNewWorkflow(prev => ({ ...prev, is_active: e.target.checked }))} />
              <span className="text-xs text-gray-400 uppercase tracking-widest">Active</span>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={newWorkflow.is_hidden} onChange={(e) => setNewWorkflow(prev => ({ ...prev, is_hidden: e.target.checked }))} />
              <span className="text-xs text-gray-400 uppercase tracking-widest">Hidden</span>
            </div>
            <div className="flex justify-end">
              <button className="px-6 py-3 rounded-2xl gradient-btn text-white text-xs font-black uppercase tracking-widest">Create Workflow</button>
            </div>
          </form>
        </section>

        <section className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-black uppercase tracking-widest text-gray-400">Workflows</h2>
            {loading.workflows && <span className="text-xs text-gray-500">Loading...</span>}
          </div>
          {workflows.length === 0 && !loading.workflows && (
            <div className="glass rounded-2xl p-6 border border-white/10 text-sm text-gray-500">No workflows found.</div>
          )}
          {workflows.map(workflow => {
            const versions = versionsByWorkflow[workflow.id] || [];
            const draft = versionDrafts[workflow.id] || buildDraftFromWorkflow(workflow);
            const testInput = testInputs[workflow.id] || '';
            const testResult = testResults[workflow.id];
            const isExpanded = expandedWorkflowId === workflow.id;
            const publishedVersionId = workflow.published_version?.id || null;
            const versionActionLabel = publishedVersionId ? 'Save Version' : 'Create Version';
            const versionActionHandler = publishedVersionId
              ? () => handleUpdateVersion(workflow.id, publishedVersionId)
              : () => handleCreateVersion(workflow.id);

            return (
              <div key={workflow.id} className="glass rounded-[2.5rem] p-8 border border-white/10 space-y-6">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div>
                    <div className="text-lg font-semibold text-white">{workflow.display_name}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-widest mt-2 flex flex-wrap gap-2">
                      <span>slug: {workflow.slug}</span>
                      <span>provider: {workflow.provider_name || 'runninghub_ai'}</span>
                      <span>credits: {workflow.credit_per_unit}</span>
                      <span>order: {workflow.sort_order ?? 0}</span>
                      <span className={workflow.is_active === false ? 'text-red-300' : 'text-emerald-300'}>
                        {workflow.is_active === false ? 'inactive' : 'active'}
                      </span>
                      <span className={workflow.is_hidden ? 'text-amber-300' : 'text-gray-400'}>
                        {workflow.is_hidden ? 'hidden' : 'visible'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleQuickToggleHidden(workflow)}
                      className="px-4 py-2 rounded-xl bg-white/10 text-white text-[10px] font-black uppercase tracking-widest hover:bg-white/20 transition"
                    >
                      {workflow.is_hidden ? 'Show' : 'Hide'}
                    </button>
                    <button
                      onClick={() => handleSortBump(workflow, -1)}
                      className="px-3 py-2 rounded-xl bg-white/10 text-white text-[10px] font-black uppercase tracking-widest hover:bg-white/20 transition"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => handleSortBump(workflow, 1)}
                      className="px-3 py-2 rounded-xl bg-white/10 text-white text-[10px] font-black uppercase tracking-widest hover:bg-white/20 transition"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => setExpandedWorkflowId(isExpanded ? null : workflow.id)}
                      className="px-4 py-2 rounded-xl bg-white/10 text-white text-[10px] font-black uppercase tracking-widest hover:bg-white/20 transition"
                    >
                      {isExpanded ? 'Close' : 'Edit'}
                    </button>
                    {isExpanded && (
                      <button onClick={() => handleSaveWorkflow(workflow)} className="px-6 py-2 rounded-xl bg-indigo-500 text-white text-[10px] font-black uppercase tracking-widest">
                        Save Changes
                      </button>
                    )}
                  </div>
                </div>

                <div className="text-xs text-gray-500 uppercase tracking-widest">
                  Published: {workflow.published_version ? `v${workflow.published_version.version} / ${workflow.published_version.workflow_remote_id}` : 'None'}
                </div>

                {isExpanded && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Display Name</label>
                        <input value={workflow.display_name} onChange={(e) => updateWorkflowField(workflow.id, 'display_name', e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Slug</label>
                        <input value={workflow.slug} readOnly className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-gray-500" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Credits Per Unit</label>
                        <input value={workflow.credit_per_unit} onChange={(e) => updateWorkflowField(workflow.id, 'credit_per_unit', e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Sort Order</label>
                        <input value={workflow.sort_order ?? 0} onChange={(e) => updateWorkflowField(workflow.id, 'sort_order', Number(e.target.value))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Provider</label>
                        <select value={workflow.provider_name || 'runninghub_ai'} onChange={(e) => updateWorkflowField(workflow.id, 'provider_name', e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
                          <option value="runninghub_ai">runninghub_ai</option>
                          <option value="runninghub_cn">runninghub_cn</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Preview Before URL</label>
                        <input value={workflow.preview_original || ''} onChange={(e) => updateWorkflowField(workflow.id, 'preview_original', e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Preview After URL</label>
                        <input value={workflow.preview_processed || ''} onChange={(e) => updateWorkflowField(workflow.id, 'preview_processed', e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" />
                      </div>
                      <div className="lg:col-span-2">
                        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-2">Description</label>
                        <textarea value={workflow.description || ''} onChange={(e) => updateWorkflowField(workflow.id, 'description', e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 h-24" />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" checked={workflow.is_active ?? true} onChange={(e) => updateWorkflowField(workflow.id, 'is_active', e.target.checked)} />
                      <span className="text-xs text-gray-400 uppercase tracking-widest">Active</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" checked={workflow.is_hidden ?? false} onChange={(e) => updateWorkflowField(workflow.id, 'is_hidden', e.target.checked)} />
                      <span className="text-xs text-gray-400 uppercase tracking-widest">Hidden</span>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div className="space-y-3">
                        <h3 className="text-[10px] uppercase tracking-widest text-gray-500">
                          {publishedVersionId ? 'Edit Published Version' : 'Create Version'}
                        </h3>
                        <input value={draft.workflow_remote_id} onChange={(e) => setVersionDrafts(prev => ({ ...prev, [workflow.id]: { ...draft, workflow_remote_id: e.target.value } }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="workflow_remote_id" />
                        <input value={draft.input_node_key} onChange={(e) => setVersionDrafts(prev => ({ ...prev, [workflow.id]: { ...draft, input_node_key: e.target.value } }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="input_node_key" />
                        <input value={draft.input_node_id} onChange={(e) => setVersionDrafts(prev => ({ ...prev, [workflow.id]: { ...draft, input_node_id: e.target.value } }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="input_node_id (e.g. 31)" />
                        <input value={draft.output_node_id} onChange={(e) => setVersionDrafts(prev => ({ ...prev, [workflow.id]: { ...draft, output_node_id: e.target.value } }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="output_node_id (e.g. 57)" />
                        <select value={draft.api_mode} onChange={(e) => setVersionDrafts(prev => ({ ...prev, [workflow.id]: { ...draft, api_mode: e.target.value } }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
                          <option value="task_openapi">api_mode: task_openapi</option>
                          <option value="workflow">api_mode: workflow</option>
                        </select>
                        <textarea value={draft.runtime_config} onChange={(e) => setVersionDrafts(prev => ({ ...prev, [workflow.id]: { ...draft, runtime_config: e.target.value } }))} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 h-20" placeholder='{"poll_interval": 4000}' />
                        <div className="flex items-center gap-3">
                          <input type="checkbox" checked={draft.is_published} onChange={(e) => setVersionDrafts(prev => ({ ...prev, [workflow.id]: { ...draft, is_published: e.target.checked } }))} />
                          <span className="text-xs text-gray-400 uppercase tracking-widest">Publish After Create</span>
                        </div>
                        <button onClick={versionActionHandler} className="px-4 py-2 rounded-xl bg-indigo-500 text-white text-xs font-black uppercase tracking-widest">
                          {versionActionLabel}
                        </button>
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="text-[10px] uppercase tracking-widest text-gray-500">Versions</h3>
                          <button onClick={() => handleLoadVersions(workflow.id)} className="text-[10px] uppercase tracking-widest text-indigo-400">Load</button>
                        </div>
                        <div className="space-y-3 max-h-52 overflow-y-auto pr-1">
                          {versions.length === 0 && (
                            <div className="text-xs text-gray-500">No versions loaded.</div>
                          )}
                          {versions.map(version => (
                            <div key={version.id} className="flex items-center justify-between text-xs border border-white/10 rounded-xl px-3 py-2">
                              <div className="flex flex-col">
                                <span className="text-gray-200">v{version.version} - {version.workflow_remote_id}</span>
                                <span className="text-gray-500">{version.is_published ? 'published' : 'draft'}</span>
                              </div>
                              {!version.is_published && (
                                <button onClick={() => handlePublishVersion(workflow.id, version.id)} className="px-3 py-1 rounded-lg bg-white/10 text-[10px] uppercase tracking-widest">Publish</button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h3 className="text-[10px] uppercase tracking-widest text-gray-500">Test Run</h3>
                      <div className="flex flex-col lg:flex-row gap-3">
                        <input value={testInput} onChange={(e) => setTestInputs(prev => ({ ...prev, [workflow.id]: e.target.value }))} className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-4 py-3" placeholder="https://example.com/input.jpg" />
                        <button onClick={() => handleTestRun(workflow.id)} className="px-4 py-2 rounded-xl bg-white/10 text-xs uppercase tracking-widest">Run</button>
                      </div>
                      {testResult && (
                        <pre className="text-xs bg-black/30 border border-white/10 rounded-2xl p-4 overflow-auto">{JSON.stringify(testResult, null, 2)}</pre>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>

        <section className="glass rounded-[2.5rem] p-8 border border-white/10">
          <h2 className="text-sm font-black uppercase tracking-widest text-gray-400 mb-6">Recent Jobs</h2>
          {loading.jobs && <div className="text-xs text-gray-500 mb-4">Loading...</div>}
          {!loading.jobs && jobs.length === 0 && (
            <div className="text-xs text-gray-500">No jobs found.</div>
          )}
          <div className="space-y-3">
            {jobs.map(job => (
              <div key={job.id} className="border border-white/10 rounded-2xl px-4 py-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-gray-200">{job.project_name || job.id}</div>
                  <div className="text-[10px] uppercase tracking-widest text-gray-500">{job.status}</div>
                </div>
                {job.error_message && (
                  <div className="text-[10px] text-red-300 mt-2">Job Error: {job.error_message}</div>
                )}
                {job.group_errors && job.group_errors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {job.group_errors.map((group) => (
                      <div key={`${job.id}-${group.group_index}`} className="text-[10px] text-orange-200">
                        Group {group.group_index}: {group.last_error || 'Unknown error'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="glass rounded-[2.5rem] p-8 border border-white/10">
          <h2 className="text-sm font-black uppercase tracking-widest text-gray-400 mb-6">User Credits</h2>
          {loading.credits && <div className="text-xs text-gray-500 mb-4">Loading...</div>}
          <div className="space-y-3">
            {credits.map(row => {
              const draft = creditDrafts[row.user_id] || { delta: '', note: '' };
              return (
                <div key={row.user_id} className="grid grid-cols-1 lg:grid-cols-6 gap-3 items-center border border-white/10 rounded-2xl px-4 py-3 text-xs">
                  <div className="lg:col-span-2">
                    <div className="text-gray-200">{row.email || row.user_id}</div>
                    {row.is_admin && <div className="text-[10px] text-indigo-400 uppercase tracking-widest">Admin</div>}
                  </div>
                  <div className="text-gray-400">Available: {row.available_credits}</div>
                  <div className="text-gray-400">Reserved: {row.reserved_credits}</div>
                  <input value={draft.delta} onChange={(e) => setCreditDrafts(prev => ({ ...prev, [row.user_id]: { ...draft, delta: e.target.value } }))} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2" placeholder="+10 / -10" />
                  <div className="flex gap-2">
                    <input value={draft.note} onChange={(e) => setCreditDrafts(prev => ({ ...prev, [row.user_id]: { ...draft, note: e.target.value } }))} className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2" placeholder="note" />
                    <button onClick={() => handleAdjustCredits(row)} className="px-3 py-2 rounded-xl bg-white/10 uppercase tracking-widest text-[10px]">Apply</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};

export default Admin;
