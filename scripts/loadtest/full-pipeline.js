import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  API_BASE_URL,
  buildTokens,
  pickToken,
  jsonHeaders,
  resolveWorkflowPayload,
  randomBytes,
  randomId,
} from './_helpers.js';

const overallP95Ms = Math.max(1500, Number(__ENV.P95_MS || 60000));
const controlP95Ms = Math.max(500, Number(__ENV.CONTROL_P95_MS || 2000));
const uploadP95Ms = Math.max(1500, Number(__ENV.UPLOAD_P95_MS || 60000));
const failRate = Math.min(1, Math.max(0, Number(__ENV.FAIL_RATE || 0.02)));
const uploadParallel = Math.max(1, Number(__ENV.UPLOAD_PARALLEL || 6));
const multipartThresholdBytes = Math.max(0, Number(__ENV.MULTIPART_THRESHOLD_MB || 20) * 1024 * 1024);
const multipartParallel = Math.max(1, Number(__ENV.MULTIPART_PARALLEL || 4));

export const options = {
  vus: Number(__ENV.VUS || 2),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    http_req_failed: [`rate<${failRate}`],
    http_req_duration: [`p(95)<${overallP95Ms}`],
    'http_req_duration{phase:control}': [`p(95)<${controlP95Ms}`],
    'http_req_duration{phase:upload}': [`p(95)<${uploadP95Ms}`],
  },
};

export const setup = () => {
  const tokens = buildTokens();
  const workflowPayload = resolveWorkflowPayload(tokens[0]);
  return { tokens, workflowPayload };
};

const logFailure = (label, res) => {
  if (res && res.status === 200) return;
  const snippet = res?.body ? res.body.slice(0, 200) : '';
  console.log(`${label} ${res?.status || 'no-response'} ${snippet}`);
};

export default function (data) {
  const token = pickToken(data.tokens);
  const headers = jsonHeaders(token);
  const controlParams = (endpoint) => ({ headers, tags: { phase: 'control', endpoint } });

  const jobRes = http.post(
    `${API_BASE_URL}/jobs/create`,
    JSON.stringify({
      ...data.workflowPayload,
      projectName: `Pipeline-${__VU}-${Date.now()}`,
    }),
    controlParams('jobs_create')
  );
  check(jobRes, { 'job create 200': (r) => r.status === 200 });
  const jobId = jobRes.json('id');
  if (!jobId) return;

  const fileCount = Number(__ENV.FILE_COUNT || 3);
  const fileSizeBytes = Math.max(16 * 1024, Number(__ENV.FILE_SIZE_KB || 256) * 1024);
  const nowIso = new Date().toISOString();

  const files = [];
  const fileIds = [];
  for (let i = 0; i < fileCount; i += 1) {
    const id = randomId(12);
    const name = `IMG_${__VU}_${Date.now()}_${i}.jpg`;
    const useMultipart = fileSizeBytes > multipartThresholdBytes;
    files.push({
      id,
      name,
      size: fileSizeBytes,
      type: 'image/jpeg',
      exifTime: nowIso,
      ev: 0,
      useMultipart,
    });
    fileIds.push(id);
  }

  const groups = [{
    id: randomId(12),
    index: 1,
    groupType: 'group',
    fileIds,
  }];

  const groupsRes = http.post(
    `${API_BASE_URL}/jobs/${jobId}/groups`,
    JSON.stringify({ files, groups }),
    controlParams('groups')
  );
  check(groupsRes, { 'groups 200': (r) => r.status === 200 });
  logFailure('groups', groupsRes);

  const startRes = http.post(
    `${API_BASE_URL}/jobs/${jobId}/start`,
    JSON.stringify({}),
    controlParams('start')
  );
  check(startRes, { 'start 200': (r) => r.status === 200 });
  logFailure('start', startRes);

  const simpleFiles = files.filter((file) => !file.useMultipart);
  const multipartFiles = files.filter((file) => file.useMultipart);

  let presignMap = new Map();
  if (simpleFiles.length > 0) {
    const presignRes = http.post(
      `${API_BASE_URL}/jobs/${jobId}/presign-raw`,
      JSON.stringify({
        files: simpleFiles.map((file) => ({
          id: file.id,
          name: file.name,
          type: file.type,
          size: file.size,
        })),
      }),
      controlParams('presign_raw')
    );
    check(presignRes, { 'presign 200': (r) => r.status === 200 });
    logFailure('presign', presignRes);
    const presigned = presignRes.json();
    if (Array.isArray(presigned)) {
      presignMap = new Map(presigned.map((row) => [row.fileId, row]));
    }
  }

  const multipartSessions = new Map();
  if (multipartFiles.length > 0) {
    const initPayloads = multipartFiles.map((file) => ({
      file,
      request: {
        method: 'POST',
        url: `${API_BASE_URL}/jobs/${jobId}/presign-raw-multipart`,
        body: JSON.stringify({
          file: {
            id: file.id,
            name: file.name,
            type: file.type,
            size: file.size,
          },
        }),
        params: controlParams('presign_raw_multipart'),
      },
    }));

    for (let i = 0; i < initPayloads.length; i += uploadParallel) {
      const slice = initPayloads.slice(i, i + uploadParallel);
      const responses = http.batch(slice.map((item) => item.request));
      responses.forEach((res, idx) => {
        const file = slice[idx].file;
        check(res, { 'presign multipart 200': (r) => r.status === 200 });
        if (res.status !== 200) {
          logFailure('presign-multipart', res);
          return;
        }
        const uploadId = res.json('uploadId');
        const key = res.json('key');
        const partSize = res.json('partSize');
        const partUrls = res.json('partUrls');
        if (!uploadId || !key || !partSize || !Array.isArray(partUrls)) return;
        multipartSessions.set(file.id, {
          file,
          uploadId,
          key,
          partSize,
          partUrls,
          parts: [],
        });
      });
    }
  }

  const payload = randomBytes(fileSizeBytes);
  const uploaded = [];

  const simpleTasks = simpleFiles
    .map((file) => {
      const entry = presignMap.get(file.id);
      if (!entry || !entry.putUrl) return null;
      return { file, entry };
    })
    .filter(Boolean);

  for (let i = 0; i < simpleTasks.length; i += uploadParallel) {
    const slice = simpleTasks.slice(i, i + uploadParallel);
    const batch = slice.map((task) => ({
      method: 'PUT',
      url: task.entry.putUrl,
      body: payload,
      params: {
        headers: { 'Content-Type': task.file.type },
        tags: { phase: 'upload', endpoint: 'r2_put' },
      },
    }));
    const responses = http.batch(batch);
    responses.forEach((res, idx) => {
      check(res, { 'put 200/204': (r) => r.status === 200 || r.status === 204 });
      const task = slice[idx];
      if ((res.status === 200 || res.status === 204) && task.entry?.r2Key) {
        uploaded.push({ id: task.file.id, r2_key: task.entry.r2Key });
      }
    });
  }

  if (multipartSessions.size > 0) {
    const pendingParts = [];
    multipartSessions.forEach((session) => {
      session.partUrls.forEach((part) => {
        const start = (part.partNumber - 1) * session.partSize;
        const end = Math.min(start + session.partSize, session.file.size);
        pendingParts.push({
          fileId: session.file.id,
          partNumber: part.partNumber,
          url: part.url,
          start,
          end,
          contentType: session.file.type,
        });
      });
    });

    for (let i = 0; i < pendingParts.length; i += multipartParallel) {
      const slice = pendingParts.slice(i, i + multipartParallel);
      const batch = slice.map((part) => ({
        method: 'PUT',
        url: part.url,
        body: payload.slice(part.start, part.end),
        params: {
          headers: { 'Content-Type': part.contentType || 'application/octet-stream' },
          tags: { phase: 'upload', endpoint: 'r2_part' },
        },
      }));
      const responses = http.batch(batch);
      responses.forEach((res, idx) => {
        check(res, { 'part 200/204': (r) => r.status === 200 || r.status === 204 });
        if (res.status !== 200 && res.status !== 204) return;
        const part = slice[idx];
        const session = multipartSessions.get(part.fileId);
        if (!session) return;
        const etag = res.headers.ETag || res.headers.Etag || '';
        if (!etag) return;
        session.parts.push({ partNumber: part.partNumber, etag });
      });
    }

    const completePayloads = [];
    multipartSessions.forEach((session) => {
      const parts = session.parts
        .filter((part) => part?.etag)
        .sort((a, b) => a.partNumber - b.partNumber);
      if (parts.length === 0) return;
      completePayloads.push({
        file: session.file,
        key: session.key,
        body: JSON.stringify({
          uploadId: session.uploadId,
          key: session.key,
          parts,
        }),
      });
    });

    for (let i = 0; i < completePayloads.length; i += uploadParallel) {
      const slice = completePayloads.slice(i, i + uploadParallel);
      const batch = slice.map((item) => ({
        method: 'POST',
        url: `${API_BASE_URL}/jobs/${jobId}/complete-raw-multipart`,
        body: item.body,
        params: controlParams('complete_raw_multipart'),
      }));
      const responses = http.batch(batch);
      responses.forEach((res, idx) => {
        check(res, { 'complete multipart 200': (r) => r.status === 200 });
        const item = slice[idx];
        if (res.status === 200) {
          uploaded.push({ id: item.file.id, r2_key: item.key });
        } else {
          logFailure('complete-multipart', res);
        }
      });
    }
  }

  if (uploaded.length > 0) {
    const uploadedRes = http.post(
      `${API_BASE_URL}/jobs/${jobId}/file_uploaded`,
      JSON.stringify({ files: uploaded }),
      controlParams('file_uploaded')
    );
    check(uploadedRes, { 'file_uploaded 200': (r) => r.status === 200 });
  }

  const previewRes = http.post(
    `${API_BASE_URL}/jobs/${jobId}/previews`,
    JSON.stringify({}),
    controlParams('previews')
  );
  check(previewRes, { 'previews 200/503': (r) => r.status === 200 || r.status === 503 });

  const waitSec = Number(__ENV.MAX_WAIT_SEC || 0);
  if (waitSec > 0) {
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline) {
      const statusRes = http.get(`${API_BASE_URL}/jobs/${jobId}/status`, controlParams('status'));
      const status = statusRes.json('job.status');
      if (['completed', 'partial', 'failed', 'canceled'].includes(status)) break;
      sleep(3);
    }
  }
}
