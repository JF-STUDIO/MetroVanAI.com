import { Response } from 'express';

type TaskEvent =
  | { type: 'image_ready'; index: number; imageUrl: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

const streams = new Map<string, Response>();

const writeEvent = (res: Response, payload: TaskEvent) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const attachTaskStream = (taskId: string, res: Response) => {
  const existing = streams.get(taskId);
  if (existing && existing !== res) {
    try {
      existing.end();
    } catch {
      // ignore
    }
  }

  streams.set(taskId, res);

  const cleanup = () => {
    if (streams.get(taskId) === res) {
      streams.delete(taskId);
    }
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
};

export const emitTaskEvent = (taskId: string, payload: TaskEvent) => {
  const res = streams.get(taskId);
  if (!res) return false;

  writeEvent(res, payload);

  if (payload.type === 'done' || payload.type === 'error') {
    try {
      res.end();
    } finally {
      streams.delete(taskId);
    }
  }

  return true;
};
