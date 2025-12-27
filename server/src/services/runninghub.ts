import axios from 'axios';
import FormData from 'form-data';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';

export type RunningHubStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';
type RunningHubApiMode = 'workflow' | 'task_openapi';

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

const resolveApiMode = (runtimeConfig?: Record<string, unknown> | null): RunningHubApiMode => {
  const mode = (runtimeConfig?.api_mode as string | undefined) || 'workflow';
  return mode === 'task_openapi' ? 'task_openapi' : 'workflow';
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
  if (typeof data.taskId === 'string') return data.taskId;
  if (typeof data.taskID === 'string') return data.taskID;
  return (
    data.task_id ||
    data.id ||
    data.taskId ||
    data.taskID ||
    data?.data?.task_id ||
    data?.data?.taskId ||
    data?.data?.taskID ||
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

const parseStatus = (
  provider: RunningHubProvider,
  payload: any,
  runtimeConfig?: Record<string, unknown> | null
): RunningHubStatus => {
  if (!payload) return 'RUNNING';
  const data = payload?.data ?? payload;

  if (resolveApiMode(runtimeConfig) === 'task_openapi') {
    if (typeof data === 'string') return normalizeStatus(data);
  }

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

const downloadInputToFile = async (inputUrl: string) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvai-runninghub-'));
  const fileName = `input${path.extname(new URL(inputUrl).pathname) || '.bin'}`;
  const filePath = path.join(tempDir, fileName);
  const response = await axios.get(inputUrl, { responseType: 'stream' });
  await pipeline(response.data, createWriteStream(filePath));
  return { tempDir, filePath };
};

const uploadTaskOpenApi = async (baseUrl: string, filePath: string, runtimeConfig?: Record<string, unknown> | null) => {
  const apiKey = ensureApiKey();
  const uploadPath = (runtimeConfig?.upload_path as string | undefined) || '/task/openapi/upload';
  const url = normalizeUrl(baseUrl, uploadPath);

  const form = new FormData();
  form.append('apiKey', apiKey);
  form.append('file', createReadStream(filePath), path.basename(filePath));

  const headers = { ...form.getHeaders(), Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey };
  const { data } = await axios.post(url, form, {
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000
  });

  if (data?.code !== 0) {
    throw new Error(`RunningHub upload failed: ${JSON.stringify(data)}`);
  }

  const fileName = data?.data?.fileName || data?.data?.filename || data?.data?.name;
  if (!fileName) {
    throw new Error('RunningHub upload missing fileName');
  }
  return { fileName, raw: data };
};

const createTaskOpenApi = async (
  baseUrl: string,
  workflowRemoteId: string,
  inputKey: string,
  inputNodeId: string,
  fileName: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  const apiKey = ensureApiKey();
  const createPath = (runtimeConfig?.create_path as string | undefined) || '/task/openapi/create';
  const url = normalizeUrl(baseUrl, createPath);
  const payload = {
    apiKey,
    workflowId: workflowRemoteId,
    nodeInfoList: [
      {
        nodeId: inputNodeId,
        fieldName: inputKey,
        fieldValue: fileName
      }
    ]
  };

  const { data } = await axios.post(url, payload, {
    headers: buildHeaders(),
    timeout: 180000
  });

  if (data?.code !== 0) {
    throw new Error(`RunningHub create failed: ${JSON.stringify(data)}`);
  }

  const taskId = data?.data?.taskId || data?.data?.task_id || data?.taskId || data?.task_id;
  if (!taskId) {
    throw new Error(`RunningHub task id missing from response${data?.msg ? ` (${data.msg})` : ''}`);
  }
  return { taskId, raw: data };
};

export const createRunningHubTask = async (
  provider: RunningHubProvider,
  workflowRemoteId: string,
  inputKey: string,
  inputUrl: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  if (resolveApiMode(runtimeConfig) === 'task_openapi') {
    const inputNodeId = (runtimeConfig?.input_node_id as string | number | undefined);
    if (!inputNodeId) {
      throw new Error('RunningHub input_node_id is required for task_openapi');
    }

    const { tempDir, filePath } = await downloadInputToFile(inputUrl);
    try {
      const uploaded = await uploadTaskOpenApi(provider.base_url, filePath, runtimeConfig);
      return await createTaskOpenApi(
        provider.base_url,
        workflowRemoteId,
        inputKey,
        String(inputNodeId),
        uploaded.fileName,
        runtimeConfig
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  const url = normalizeUrl(provider.base_url, provider.create_path);
  const payload = buildPayload(workflowRemoteId, inputKey, inputUrl, runtimeConfig);
  const { data } = await axios.post(url, payload, {
    headers: buildHeaders(),
    timeout: (runtimeConfig?.timeout as number | undefined) ? (runtimeConfig?.timeout as number) * 1000 : 120000
  });

  const taskId = extractTaskId(data);
  if (!taskId) {
    const details =
      data?.message ||
      data?.msg ||
      data?.error ||
      data?.code ||
      data?.status ||
      null;
    const hint = details ? ` (${details})` : '';
    throw new Error(`RunningHub task id missing from response${hint}`);
  }

  return { taskId, raw: data };
};

export const fetchRunningHubStatus = async (
  provider: RunningHubProvider,
  taskId: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  const apiMode = resolveApiMode(runtimeConfig);
  const statusPath = apiMode === 'task_openapi'
    ? (runtimeConfig?.status_path as string | undefined) || '/task/openapi/status'
    : provider.status_path;
  const url = normalizeUrl(provider.base_url, statusPath);

  if (apiMode === 'task_openapi') {
    const apiKey = ensureApiKey();
    const { data } = await axios.post(url, { apiKey, taskId }, {
      headers: buildHeaders(),
      timeout: 30000
    });
    const status = parseStatus(provider, data, runtimeConfig);
    return { status, outputUrls: [], raw: data };
  }

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
  const status = parseStatus(provider, data, runtimeConfig);
  const outputUrls = extractOutputUrls(data);
  return { status, outputUrls, raw: data };
};

const fetchTaskOpenApiOutputs = async (
  provider: RunningHubProvider,
  taskId: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  const apiKey = ensureApiKey();
  const outputsPath = (runtimeConfig?.outputs_path as string | undefined) || '/task/openapi/outputs';
  const url = normalizeUrl(provider.base_url, outputsPath);
  const payload = { apiKey, taskId };
  const { data } = await axios.post(url, payload, {
    headers: buildHeaders(),
    timeout: 180000
  });
  if (data?.code !== 0) {
    throw new Error(`RunningHub outputs failed: ${JSON.stringify(data)}`);
  }
  return data?.data || [];
};

const pickOutputFromOpenApi = (outputs: any[], runtimeConfig?: Record<string, unknown> | null) => {
  const outputNodeId = runtimeConfig?.output_node_id as string | number | undefined;
  if (outputNodeId) {
    const match = outputs.find((item) => String(item?.nodeId ?? item?.node_id ?? item?.node) === String(outputNodeId));
    const fileUrl = match?.fileUrl || match?.url;
    if (fileUrl) return [fileUrl];
  }
  const first = outputs.find((item) => item?.fileUrl || item?.url);
  return first ? [first.fileUrl || first.url] : [];
};

export const pollRunningHub = async (
  provider: RunningHubProvider,
  taskId: string,
  runtimeConfig?: Record<string, unknown> | null
) => {
  const timeoutSeconds = (runtimeConfig?.timeout as number | undefined) ?? 900;
  const pollIntervalSeconds = (runtimeConfig?.poll_interval as number | undefined) ?? 5;
  const timeoutAt = Date.now() + timeoutSeconds * 1000;
  const apiMode = resolveApiMode(runtimeConfig);

  while (Date.now() < timeoutAt) {
    const result = await fetchRunningHubStatus(provider, taskId, runtimeConfig);
    if (result.status === 'SUCCESS' || result.status === 'FAILED') {
      if (result.status === 'SUCCESS' && apiMode === 'task_openapi') {
        const outputs = await fetchTaskOpenApiOutputs(provider, taskId, runtimeConfig);
        const outputUrls = pickOutputFromOpenApi(outputs, runtimeConfig);
        return { ...result, outputUrls };
      }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
  }

  throw new Error('RunningHub status polling timed out');
};
