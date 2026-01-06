/* eslint-disable no-restricted-globals */
import exifr from 'exifr';

type WorkerFile = File;

type WorkerItem = {
  id: string;
  file: WorkerFile;
};

type GroupingOptions = {
  timeThresholdMs?: number;
};

type GroupFileMeta = {
  id: string;
  name: string;
  size: number;
  type: string;
  exifTime?: string | null;
  ev?: number | null;
  lastModified?: number | null;
};

type GroupResult = {
  id: string;
  index: number;
  fileIds: string[];
  fileMetas: GroupFileMeta[];
  groupType: 'single' | 'group';
};

const readExif = async (file: WorkerFile) => {
  const slice = file.slice(0, 256 * 1024);
  const buffer = await slice.arrayBuffer();
  try {
    return await exifr.parse(buffer, {
      pick: [
        'DateTimeOriginal',
        'CreateDate',
        'ModifyDate',
        'ExposureBiasValue',
        'ExposureCompensation',
        'ExposureTime',
        'FNumber',
        'ISOSpeedRatings',
        'ISO'
      ]
    });
  } catch (error) {
    return null;
  }
};

const normalizeDate = (value: unknown) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const computeEv = (tags: Record<string, any> | null) => {
  if (!tags) return null;
  const bias = tags.ExposureBiasValue ?? tags.ExposureCompensation;
  if (typeof bias === 'number' && Number.isFinite(bias)) {
    return bias;
  }
  return null;
};

const getCaptureTime = (tags: Record<string, any> | null, fallbackMs: number) => {
  const dt = normalizeDate(tags?.DateTimeOriginal)
    || normalizeDate(tags?.CreateDate)
    || normalizeDate(tags?.ModifyDate);
  if (dt) return dt.getTime();
  return fallbackMs;
};

const groupByTime = (files: GroupFileMeta[], thresholdMs: number) => {
  const sorted = [...files].sort((a, b) => (a.exifTime || '').localeCompare(b.exifTime || ''));
  const groups: GroupResult[] = [];
  let current: GroupFileMeta[] = [];
  let currentStart: number | null = null;

  for (const file of sorted) {
    const ts = file.exifTime ? new Date(file.exifTime).getTime() : (file.lastModified || 0);
    if (currentStart === null) {
      currentStart = ts;
      current.push(file);
      continue;
    }
    if (Math.abs(ts - currentStart) <= thresholdMs) {
      current.push(file);
      continue;
    }
    groups.push(current);
    current = [file];
    currentStart = ts;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, idx) => {
    const ordered = [...group].sort((a, b) => (a.ev ?? 0) - (b.ev ?? 0));
    const groupId = self.crypto?.randomUUID ? self.crypto.randomUUID() : `${Date.now()}-${idx}`;
    return {
      id: groupId,
      index: idx + 1,
      fileIds: ordered.map((item) => item.id),
      fileMetas: ordered,
      groupType: ordered.length > 1 ? 'group' : 'single'
    };
  });
};

self.onmessage = async (event: MessageEvent<{ files?: WorkerFile[]; items?: WorkerItem[]; options?: GroupingOptions }>) => {
  const { files, items, options } = event.data;
  const sourceItems: WorkerItem[] = Array.isArray(items)
    ? items
    : (Array.isArray(files) ? files.map((file) => ({
      id: self.crypto?.randomUUID ? self.crypto.randomUUID() : `${Date.now()}-${file.name}`,
      file
    })) : []);
  const total = sourceItems.length;
  const fileMetas: GroupFileMeta[] = [];
  const threshold = options?.timeThresholdMs ?? 3500;

  for (let i = 0; i < sourceItems.length; i += 1) {
    const { file, id } = sourceItems[i];
    const tags = await readExif(file);
    const fallbackMs = file.lastModified || Date.now();
    const exifTimeMs = getCaptureTime(tags, fallbackMs);
    const meta: GroupFileMeta = {
      id,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      exifTime: new Date(exifTimeMs).toISOString(),
      ev: computeEv(tags),
      lastModified: file.lastModified
    };
    fileMetas.push(meta);
    self.postMessage({ type: 'progress', processed: i + 1, total });
  }

  const groups = groupByTime(fileMetas, threshold);

  self.postMessage({
    type: 'done',
    groups,
    files: fileMetas,
    total
  });
};
