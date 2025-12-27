import axios from 'axios';

export type RunningHubStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

export type RunningHubProvider = {
  base_url: string;
  create_path: string;
  status_path: string;
  status_mode: string;
};

type RunningHubPayloadContext = {
  input_url: string;
  input_key: string;
  workflow_id: string;
};

const ensureApiKey = () => {
  const apiKey = process.env.RUNNINGHUB_API_KEY;
  if (!apiKey) {
    throw new Error('RUNNINGHUB_API_KEY is not set');
  }
  return apiKey;
};

const buildHeaders = () => {
  const apiKey = ensureApiKey();
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-API-Key': apiKey,
    'Content-Type': 'application/json'
  };
};

const normalizeUrl = (baseUrl: string, path: string) => {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
};

const applyTemplate = (value: unknown, context: RunningHubPayloadContext): unknown => {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      const replacement = (context as Record<string, string>)[key];
      return replacement ?? '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyTemplate(item, context));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      applyTemplate(v, context)
    ]);
    return Object.fromEntries(entries);
  }
  return value;
};

const buildPayload = (
  workflowRemoteId: string,
  inputKey: string,
  inputUrl: string,
  runtimeConfig: Record<string, unknown> | null | undefined
) => {
  const context: RunningHubPayloadContext = {
    input_url: inputUrl,
    input_key: inputKey,
    workflow_id: workflowRemoteId
  };

  const template = runtimeConfig?.payload_template as Record<string, unknown> | undefined;
  if (template) {
    return applyTemplate(template, context);
  }

  const payloadMode = runtimeConfig?.payload_mode as string | undefined;
  if (payloadMode === 'flat') {
    return {
      workflow_id: workflowRemoteId,
      [inputKey]: inputUrl
    };
  }

  return {
    workflow_id: workflowRemoteId,
    inputs: {
      [inputKey]: inputUrl
    }
  };
};

const extractTaskId = (data: any) => {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (typeof data.data === 'string') return data.data;
  return (
    data.task_id ||
    data.id ||
    data?.data?.task_id ||
    data?.data?.id ||
    data?.data?.workflow_task_id ||
    null
  );
};

const normalizeStatus = (status: string | null | undefined): RunningHubStatus => {
  if (!status) return 'RUNNING';
  const value = status.toUpperCase();
  if (value.includes('SUCCESS')) return 'SUCCESS';
  if (value.includes('FAIL')) return 'FAILED';
  if (value.includes('ERROR')) return 'FAILED';
  if (value.includes('RUN')) return 'RUNNING';
  return 'RUNNING';
};

const parseStatus = (provider: RunningHubProvider, payload: any): RunningHubStatus => {
  if (!payload) return 'RUNNING';
  const data = payload?.data ?? payload;

  if (provider.status_mode === 'data_string') {
    if (typeof data === 'string') return normalizeStatus(data);
  }

  if (provider.status_mode === 'data_status_field') {
    const fieldValue = data?.status ?? payload?.status;
    return normalizeStatus(fieldValue);
  }

  if (typeof data?.status === 'string') return normalizeStatus(data.status);
  if (typeof payload?.status === 'string') return normalizeStatus(payload.status);
  return 'RUNNING';
};

const extractOutputUrls = (payload: any): string[] => {
  const data = payload?.data ?? payload;
  if (!data) return [];

  const candidates: unknown[] = [
    data.output,
    data.outputs,
    data.result,
    data.results,
    data.images,
    data.image,
    data.output_url,
    data.outputUrl
  ];

  const urls: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      urls.push(candidate);
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string') {
          urls.push(item);
        } else if (item && typeof item === 'object') {
          const url = (item as { url?: string; href?: string }).url ?? (item as { href?: string }).href;
          if (url) urls.push(url);
        }
      }
      continue;
    }
    if (typeof candidate === 'object') {
      const url = (candidate as { url?: string; href?: string }).url ?? (candidate as { href?: string }).href;
      if (url) urls.push(url);
    }
  }

  return urls;
};

export const createRunningHubTask = async (
  provider: RunningHubProvider,
  workflowRemoteId: string,
  inputKey: string,
  inputUrl: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  const url = normalizeUrl(provider.base_url, provider.create_path);
  const payload = buildPayload(workflowRemoteId, inputKey, inputUrl, runtimeConfig);
  const { data } = await axios.post(url, payload, {
    headers: buildHeaders(),
    timeout: (runtimeConfig?.timeout as number | undefined) ? (runtimeConfig?.timeout as number) * 1000 : 120000
  });

  const taskId = extractTaskId(data);
  if (!taskId) {
    throw new Error('RunningHub task id missing from response');
  }

  return { taskId, raw: data };
};

export const fetchRunningHubStatus = async (
  provider: RunningHubProvider,
  taskId: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  const url = normalizeUrl(provider.base_url, provider.status_path);
  const method = (runtimeConfig?.status_method as string | undefined)?.toUpperCase() || 'GET';
  const paramName = (runtimeConfig?.status_param as string | undefined) || 'task_id';

  const requestConfig = {
    url,
    method: method as 'GET' | 'POST',
    headers: buildHeaders(),
    timeout: 30000,
    params: method === 'GET' ? { [paramName]: taskId } : undefined,
    data: method === 'POST' ? { [paramName]: taskId } : undefined
  };

  const { data } = await axios(requestConfig);
  const status = parseStatus(provider, data);
  const outputUrls = extractOutputUrls(data);
  return { status, outputUrls, raw: data };
};

export const pollRunningHub = async (
  provider: RunningHubProvider,
  taskId: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  const timeoutSeconds = (runtimeConfig?.timeout as number | undefined) ?? 900;
  const pollIntervalSeconds = (runtimeConfig?.poll_interval as number | undefined) ?? 5;
  const timeoutAt = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < timeoutAt) {
    const result = await fetchRunningHubStatus(provider, taskId, runtimeConfig);
    if (result.status === 'SUCCESS' || result.status === 'FAILED') {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
  }

  throw new Error('RunningHub status polling timed out');
};
