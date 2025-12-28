import axios from 'axios';
import { supabase } from './supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
});

// 自动注入 Supabase Token
api.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`;
  }
  return config;
});

export const jobService = {
  getWorkflows: async () => {
    const response = await api.get('/workflows');
    return response.data;
  },

  getTools: async () => {
    const response = await api.get('/tools');
    return response.data;
  },

  createJob: async (toolId: string, projectName: string) => {
    const response = await api.post('/jobs', { toolId, projectName });
    return response.data;
  },

  createWorkflowJob: async (workflowId: string, projectName: string) => {
    const response = await api.post('/jobs/create', { workflowId, projectName });
    return response.data;
  },

  getPresignedRawUploadUrls: async (jobId: string, files: { name: string; type: string; size?: number }[]) => {
    const response = await api.post(`/jobs/${jobId}/presign-raw`, { files });
    return response.data;
  },

  getPresignedUploadUrls: async (jobId: string, files: { name: string; type: string }[]) => {
    const response = await api.post(`/jobs/${jobId}/presign-upload`, { files });
    return response.data;
  },

  uploadComplete: async (jobId: string, files: { r2_key: string; filename?: string; size?: number; exif_time?: string | null }[]) => {
    const response = await api.post(`/jobs/${jobId}/upload-complete`, { files });
    return response.data;
  },

  analyzeJob: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/analyze`);
    return response.data;
  },

  startJob: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/start`);
    return response.data;
  },

  cancelJob: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/cancel`);
    return response.data;
  },

  retryMissing: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/retry-missing`);
    return response.data;
  },

  getPipelineStatus: async (jobId: string) => {
    const response = await api.get(`/jobs/${jobId}/status`);
    return response.data;
  },

  commitJob: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/commit`);
    return response.data;
  },

  getJobStatus: async (jobId: string) => {
    const response = await api.get(`/jobs/${jobId}`);
    return response.data;
  },

  getPresignedDownloadUrl: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/presign-download`);
    return response.data;
  },

  getHistory: async (page = 1) => {
    const response = await api.get(`/jobs?page=${page}`);
    return response.data;
  },

  deleteJob: async (jobId: string) => {
    const response = await api.delete(`/jobs/${jobId}`);
    return response.data;
  },

  getProfile: async () => {
    const response = await api.get('/profile');
    return response.data;
  },

  adminGetWorkflows: async () => {
    const response = await api.get('/admin/workflows');
    return response.data;
  },

  adminCreateWorkflow: async (payload: Record<string, unknown>) => {
    const response = await api.post('/admin/workflows', payload);
    return response.data;
  },

  adminUpdateWorkflow: async (id: string, payload: Record<string, unknown>) => {
    const response = await api.patch(`/admin/workflows/${id}`, payload);
    return response.data;
  },

  adminGetVersions: async (workflowId: string) => {
    const response = await api.get(`/admin/workflows/${workflowId}/versions`);
    return response.data;
  },

  adminCreateVersion: async (workflowId: string, payload: Record<string, unknown>) => {
    const response = await api.post(`/admin/workflows/${workflowId}/versions`, payload);
    return response.data;
  },

  adminPublishVersion: async (workflowId: string, versionId: string) => {
    const response = await api.post(`/admin/workflows/${workflowId}/publish/${versionId}`);
    return response.data;
  },

  adminTestRun: async (workflowId: string, payload: Record<string, unknown>) => {
    const response = await api.post(`/admin/workflows/${workflowId}/test-run`, payload);
    return response.data;
  },

  adminGetCredits: async () => {
    const response = await api.get('/admin/credits');
    return response.data;
  },

  adminGetJobs: async (limit = 20) => {
    const response = await api.get(`/admin/jobs?limit=${limit}`);
    return response.data;
  },

  adminAdjustCredits: async (payload: Record<string, unknown>) => {
    const response = await api.post('/admin/credits/adjust', payload);
    return response.data;
  },

  recharge: async (amount: number) => {
    const response = await api.post('/recharge', { amount });
    return response.data;
  }
};
