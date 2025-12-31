import { Response } from 'express';
import { supabaseAdmin } from './supabase.js';

type JobEventPayload = {
  type: string;
  [key: string]: unknown;
};

const streams = new Map<string, Response>();

const writeEvent = (res: Response, payload: JobEventPayload, eventId?: number | null) => {
  if (eventId) {
    res.write(`id: ${eventId}\n`);
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const attachJobStream = (jobId: string, res: Response) => {
  const existing = streams.get(jobId);
  if (existing && existing !== res) {
    try {
      existing.end();
    } catch {
      // ignore
    }
  }

  streams.set(jobId, res);

  const cleanup = () => {
    if (streams.get(jobId) === res) {
      streams.delete(jobId);
    }
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
};

export const emitJobEvent = async (jobId: string, payload: JobEventPayload) => {
  let eventId: number | null = null;
  try {
    const { data, error } = await (supabaseAdmin.from('job_events') as any)
      .insert({
        job_id: jobId,
        event_type: payload.type,
        payload
      })
      .select('event_id')
      .single();
    if (!error && data?.event_id) {
      eventId = data.event_id as number;
    }
  } catch {
    // ignore persistence errors, still try to notify
  }

  const res = streams.get(jobId);
  if (!res) return false;

  writeEvent(res, payload, eventId);

  if (payload.type === 'job_done' || payload.type === 'error') {
    try {
      res.end();
    } finally {
      streams.delete(jobId);
    }
  }

  return true;
};

export const fetchJobEventsSince = async (jobId: string, lastEventId: number) => {
  const { data, error } = await (supabaseAdmin.from('job_events') as any)
    .select('event_id, payload')
    .eq('job_id', jobId)
    .gt('event_id', lastEventId)
    .order('event_id', { ascending: true });

  if (error) return [];
  return data || [];
};

export const sendInitialJobEvents = async (
  jobId: string,
  res: Response,
  lastEventId: number | null
) => {
  if (!lastEventId || lastEventId <= 0) return;
  const events = await fetchJobEventsSince(jobId, lastEventId);
  for (const event of events) {
    writeEvent(res, event.payload as JobEventPayload, event.event_id as number);
  }
};
