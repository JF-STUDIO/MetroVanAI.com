import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check } from 'k6';

export const API_BASE_URL = __ENV.API_BASE_URL || 'http://localhost:4000/api';
export const SUPABASE_URL = __ENV.SUPABASE_URL || __ENV.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY || __ENV.VITE_SUPABASE_ANON_KEY;

const requireEnv = (name, value) => {
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
};

const parseUsers = () => {
  const raw = (__ENV.TEST_USERS || '').trim();
  if (raw) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .map((entry) => {
        const [email, password] = entry.split(':');
        return { email: (email || '').trim(), password: (password || '').trim() };
      })
      .filter((user) => user.email && user.password);
  }
  return [{
    email: (__ENV.TEST_EMAIL || '').trim(),
    password: (__ENV.TEST_PASSWORD || '').trim(),
  }].filter((user) => user.email && user.password);
};

export const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

export const jsonHeaders = (token) => ({
  ...authHeaders(token),
  'Content-Type': 'application/json',
});

export const randomId = () => {
  const bytes = crypto.randomBytes(16);
  const hex = Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export const randomBytes = (bytes) => crypto.randomBytes(bytes);

const login = (email, password) => {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_ANON_KEY', SUPABASE_ANON_KEY);
  if (!email || !password) {
    throw new Error('Missing TEST_EMAIL/TEST_PASSWORD or TEST_USERS');
  }
  const url = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
  const payload = JSON.stringify({ email, password });
  const res = http.post(url, payload, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  check(res, { 'supabase auth 200': (r) => r.status === 200 });
  const token = res.json('access_token');
  if (!token) {
    throw new Error('Supabase auth did not return access_token');
  }
  return token;
};

export const buildTokens = () => {
  const users = parseUsers();
  if (users.length === 0) {
    throw new Error('No test users configured (TEST_EMAIL/TEST_PASSWORD or TEST_USERS)');
  }
  return users.map((user) => login(user.email, user.password));
};

export const pickToken = (tokens) => {
  if (!tokens || tokens.length === 0) {
    throw new Error('No tokens available');
  }
  return tokens[(__VU - 1) % tokens.length];
};

export const resolveWorkflowPayload = (token) => {
  const workflowId = (__ENV.WORKFLOW_ID || '').trim();
  if (workflowId) return { workflowId };
  const workflowSlug = (__ENV.WORKFLOW_SLUG || '').trim();
  if (workflowSlug) return { workflowSlug };

  const res = http.get(`${API_BASE_URL}/workflows`, {
    headers: authHeaders(token),
    tags: { phase: 'control', endpoint: 'workflows' },
  });
  check(res, { 'workflows 200': (r) => r.status === 200 });
  const data = res.json();
  if (!Array.isArray(data) || data.length === 0 || !data[0]?.id) {
    throw new Error('No workflows returned. Set WORKFLOW_ID or WORKFLOW_SLUG.');
  }
  return { workflowId: data[0].id };
};
