import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  API_BASE_URL,
  buildTokens,
  pickToken,
  authHeaders,
  jsonHeaders,
  resolveWorkflowPayload,
} from './_helpers.js';

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export const setup = () => {
  const tokens = buildTokens();
  const workflowPayload = resolveWorkflowPayload(tokens[0]);
  return { tokens, workflowPayload };
};

export default function (data) {
  const token = pickToken(data.tokens);
  const headers = authHeaders(token);

  const settingsRes = http.get(`${API_BASE_URL}/settings`, { headers });
  check(settingsRes, { 'settings 200': (r) => r.status === 200 });

  const workflowsRes = http.get(`${API_BASE_URL}/workflows`, { headers });
  check(workflowsRes, { 'workflows 200': (r) => r.status === 200 });

  const jobRes = http.post(
    `${API_BASE_URL}/jobs/create`,
    JSON.stringify({
      ...data.workflowPayload,
      projectName: `Loadtest-${__VU}-${Date.now()}`,
    }),
    { headers: jsonHeaders(token) }
  );
  check(jobRes, { 'job create 200': (r) => r.status === 200 });
  const jobId = jobRes.json('id');
  if (jobId) {
    const statusRes = http.get(`${API_BASE_URL}/jobs/${jobId}/status`, { headers });
    check(statusRes, { 'job status 200': (r) => r.status === 200 });
  }

  const historyRes = http.get(`${API_BASE_URL}/jobs?page=1`, { headers });
  check(historyRes, { 'jobs list 200': (r) => r.status === 200 });

  sleep(1);
}

