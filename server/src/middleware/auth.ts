import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { AuthRequest } from '../types/auth.js';

const extractBearerToken = (authHeader?: string) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.split(' ')[1] || null;
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

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = {
      id: user.id,
      email: user.email
    };
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
