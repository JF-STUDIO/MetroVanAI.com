import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  API_BASE_URL,
  buildTokens,
  pickToken,
  authHeaders,
  jsonHeaders,
  resolveWorkflowPayload,
  randomBytes,
  randomId,
} from './_helpers.js';

export const options = {
  vus: Number(__ENV.VUS || 3),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export const setup = () => {
  const tokens = buildTokens();
  const workflowPayload = resolveWorkflowPayload(tokens[0]);
  return { tokens, workflowPayload };
};

export default function (data) {
  const token = pickToken(data.tokens);
  const headers = jsonHeaders(token);

  const jobRes = http.post(
    `${API_BASE_URL}/jobs/create`,
    JSON.stringify({
      ...data.workflowPayload,
      projectName: `Upload-${__VU}-${Date.now()}`,
    }),
    { headers }
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
    files.push({
      id,
      name,
      size: fileSizeBytes,
      type: 'image/jpeg',
      exifTime: nowIso,
      ev: 0,
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
    { headers }
  );
  check(groupsRes, { 'groups 200': (r) => r.status === 200 });

  if (__ENV.RESERVE_CREDITS === 'true') {
    const startRes = http.post(`${API_BASE_URL}/jobs/${jobId}/start`, JSON.stringify({}), { headers });
    check(startRes, { 'start 200': (r) => r.status === 200 });
  }

  const presignRes = http.post(
    `${API_BASE_URL}/jobs/${jobId}/presign-raw`,
    JSON.stringify({
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
      })),
    }),
    { headers }
  );
  check(presignRes, { 'presign 200': (r) => r.status === 200 });
  const presigned = presignRes.json();
  if (!Array.isArray(presigned) || presigned.length === 0) return;

  const presignMap = new Map(presigned.map((row) => [row.fileId, row]));
  const payload = randomBytes(fileSizeBytes);
  const uploaded = [];

  files.forEach((file) => {
    const entry = presignMap.get(file.id);
    if (!entry || !entry.putUrl) return;
    const putRes = http.put(entry.putUrl, payload, {
      headers: { 'Content-Type': file.type },
    });
    check(putRes, { 'put 200/204': (r) => r.status === 200 || r.status === 204 });
    if (entry.r2Key) {
      uploaded.push({ id: file.id, r2_key: entry.r2Key });
    }
  });

  if (__ENV.TRIGGER_HDR === 'true' && uploaded.length > 0) {
    const uploadedRes = http.post(
      `${API_BASE_URL}/jobs/${jobId}/file_uploaded`,
      JSON.stringify({ files: uploaded }),
      { headers }
    );
    check(uploadedRes, { 'file_uploaded 200': (r) => r.status === 200 });
  }

  sleep(1);
}

