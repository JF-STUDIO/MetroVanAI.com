import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { AuthRequest } from '../types/auth.js';

const TOKEN_CACHE_TTL_MS = Number(process.env.AUTH_TOKEN_CACHE_TTL_MS || '30000');
const tokenCache = new Map<string, { user: { id: string; email?: string }; expiresAt: number }>();

const extractBearerToken = (authHeader?: string) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.split(' ')[1] || null;
};

const decodeJwtExp = (token: string) => {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
};

const attachUserFromToken = async (
  token: string | null,
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    req.user = cached.user;
    return next();
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userInfo = {
      id: user.id,
      email: user.email ?? undefined
    };
    req.user = userInfo;

    const exp = decodeJwtExp(token);
    const ttl = exp ? Math.min(TOKEN_CACHE_TTL_MS, exp - Date.now()) : TOKEN_CACHE_TTL_MS;
    if (ttl > 0) {
      tokenCache.set(token, { user: userInfo, expiresAt: Date.now() + Math.max(1000, ttl) });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = extractBearerToken(req.headers.authorization);
  return attachUserFromToken(token, req, res, next);
};

export const authenticateSse = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const headerToken = extractBearerToken(req.headers.authorization);
  const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
  const token = headerToken || queryToken || null;
  return attachUserFromToken(token, req, res, next);
};
