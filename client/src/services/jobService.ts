import axios from 'axios';
import { supabase } from './supabaseClient';

// Strict environment variable check for API connection
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:4000/api' : '/api');

if (!import.meta.env.DEV && !API_BASE_URL.startsWith('http')) {
  console.warn('Production API_BASE_URL is falling back to relative path. Ensure correct proxy or CORS configuration.');
}

const api = axios.create({
  baseURL: API_BASE_URL,
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const withRetry = async <T>(fn: () => Promise<T>, attempts = 3, delayMs = 800): Promise<T> => {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isAxios = axios.isAxiosError(err);
      const status = isAxios ? err.response?.status : undefined;
      const retriable = !isAxios || status === 502 || status === 503 || status === 504 || err.code === 'ECONNABORTED';
      if (i === attempts - 1 || !retriable) throw err;
      await sleep(delayMs);
    }
  }
  throw lastError as Error;
};

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

  getPublicWorkflows: async () => {
    const response = await api.get('/public/workflows');
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

  createMultipartUpload: async (jobId: string, file: { id?: string; name: string; type: string; size: number }) => {
    const response = await api.post(`/jobs/${jobId}/presign-raw-multipart`, { file });
    return response.data;
  },

  completeMultipartUpload: async (jobId: string, payload: { uploadId: string; key: string; parts: { partNumber: number; etag: string }[] }) => {
    const response = await api.post(`/jobs/${jobId}/complete-raw-multipart`, payload);
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

  registerGroups: async (jobId: string, payload: { files: any[]; groups: any[] }) => {
    const response = await api.post(`/jobs/${jobId}/groups`, payload);
    return response.data;
  },

  fileUploaded: async (jobId: string, payload: { files?: { id?: string; r2_key?: string }[]; file?: { id?: string; r2_key?: string } }) => {
    const response = await api.post(`/jobs/${jobId}/file_uploaded`, payload);
    return response.data;
  },

  analyzeJob: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/analyze`);
    return response.data;
  },

  generatePreviews: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/previews`);
    return response.data;
  },

  startJob: async (jobId: string, payload?: { skipGroupIds?: string[] }) => {
    const response = await api.post(`/jobs/${jobId}/start`, payload || {});
    return response.data;
  },

  triggerRunpod: async (jobId: string, payload?: { skipGroupIds?: string[]; mode?: 'group' | 'full' }) => {
    const response = await api.post(`/jobs/${jobId}/trigger-runpod`, payload || {});
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
    // Pipeline status includes job + groups + items + progress.
    return api.get(`/jobs/${jobId}/status`, { params: { t: Date.now() } }).then(r => r.data);
  },

  setGroupRepresentative: async (jobId: string, groupId: string, fileId: string) => {
    const response = await api.post(`/jobs/${jobId}/groups/${groupId}/representative`, { fileId });
    return response.data;
  },

  commitJob: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/commit`);
    return response.data;
  },

  getJobStatus: async (jobId: string) => {
    const response = await api.get(`/jobs/${jobId}`, {
      params: { t: Date.now() }
    });
    return response.data;
  },

  getPresignedDownloadUrl: async (jobId: string) => {
    const response = await api.post(`/jobs/${jobId}/presign-download`);
    if (response.data?.ready === false) {
      return null;
    }
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

  getProfile: async () => withRetry(async () => {
    const response = await api.get('/profile');
    return response.data;
  }),

  getSettings: async () => {
    const response = await api.get('/settings');
    return response.data;
  },

  adminGetWorkflows: async () => withRetry(async () => {
    const response = await api.get('/admin/workflows');
    return response.data;
  }),

  adminCreateWorkflow: async (payload: Record<string, unknown>) => withRetry(async () => {
    const response = await api.post('/admin/workflows', payload);
    return response.data;
  }),

  adminUpdateWorkflow: async (id: string, payload: Record<string, unknown>) => withRetry(async () => {
    const response = await api.patch(`/admin/workflows/${id}`, payload);
    return response.data;
  }),

  adminGetVersions: async (workflowId: string) => withRetry(async () => {
    const response = await api.get(`/admin/workflows/${workflowId}/versions`);
    return response.data;
  }),

  adminCreateVersion: async (workflowId: string, payload: Record<string, unknown>) => withRetry(async () => {
    const response = await api.post(`/admin/workflows/${workflowId}/versions`, payload);
    return response.data;
  }),

  adminUpdateVersion: async (workflowId: string, versionId: string, payload: Record<string, unknown>) => withRetry(async () => {
    const response = await api.patch(`/admin/workflows/${workflowId}/versions/${versionId}`, payload);
    return response.data;
  }),

  adminPublishVersion: async (workflowId: string, versionId: string) => withRetry(async () => {
    const response = await api.post(`/admin/workflows/${workflowId}/publish/${versionId}`);
    return response.data;
  }),

  adminTestRun: async (workflowId: string, payload: Record<string, unknown>) => withRetry(async () => {
    const response = await api.post(`/admin/workflows/${workflowId}/test-run`, payload);
    return response.data;
  }),

  adminGetCredits: async () => withRetry(async () => {
    const response = await api.get('/admin/credits');
    return response.data;
  }),

  adminGetJobs: async (limit = 20) => withRetry(async () => {
    const response = await api.get(`/admin/jobs?limit=${limit}`);
    return response.data;
  }),

  adminGetSettings: async () => withRetry(async () => {
    const response = await api.get('/admin/settings');
    return response.data;
  }),

  adminUpdateSettings: async (payload: Record<string, unknown>) => withRetry(async () => {
    const response = await api.patch('/admin/settings', payload);
    return response.data;
  }),

  adminAdjustCredits: async (payload: Record<string, unknown>) => withRetry(async () => {
    const response = await api.post('/admin/credits/adjust', payload);
    return response.data;
  }),

  recharge: async (amount: number) => {
    const response = await api.post('/recharge', { amount });
    return response.data;
  }
};
