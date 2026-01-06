/* eslint-disable no-restricted-globals */
import exifr from 'exifr';

type WorkerFile = File;

type WorkerItem = {
  id: string;
  file: WorkerFile;
};

type GroupingOptions = {
  timeThresholdMs?: number;
  exifParallel?: number;
  exifSliceKb?: number;
};

type GroupFileMeta = {
  id: string;
  name: string;
  size: number;
  type: string;
  exifTime?: string | null;
  ev?: number | null;
  lastModified?: number | null;
  exifTimeMs?: number | null;
};

type GroupResult = {
  id: string;
  index: number;
  fileIds: string[];
  fileMetas: GroupFileMeta[];
  groupType: 'single' | 'group';
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getDefaultParallel = () => {
  const cores = self.navigator?.hardwareConcurrency ?? 8;
  return clamp(Math.floor(cores * 0.75), 2, 8);
};

const readExif = async (file: WorkerFile, sliceBytes: number) => {
  const slice = file.slice(0, sliceBytes);
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
  const sorted = [...files].sort((a, b) => (a.exifTimeMs ?? 0) - (b.exifTimeMs ?? 0));
  const groups: GroupResult[] = [];
  let current: GroupFileMeta[] = [];
  let currentStart: number | null = null;

  for (const file of sorted) {
    const ts = file.exifTimeMs ?? file.lastModified ?? 0;
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

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  onProgress?: (count: number) => void
) => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
      completed += 1;
      if (onProgress) onProgress(completed);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
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
  const threshold = options?.timeThresholdMs ?? 3500;
  const parallel = clamp(Math.floor(options?.exifParallel ?? getDefaultParallel()), 1, 16);
  const sliceBytes = clamp(Math.floor((options?.exifSliceKb ?? 256) * 1024), 64 * 1024, 1024 * 1024);

  const fileMetas = await mapWithConcurrency(
    sourceItems,
    parallel,
    async ({ file, id }) => {
      const tags = await readExif(file, sliceBytes);
      const fallbackMs = file.lastModified || Date.now();
      const exifTimeMs = getCaptureTime(tags, fallbackMs);
      return {
        id,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        exifTime: new Date(exifTimeMs).toISOString(),
        exifTimeMs,
        ev: computeEv(tags),
        lastModified: file.lastModified
      };
    },
    (processed) => {
      self.postMessage({ type: 'progress', processed, total });
    }
  );

  const groups = groupByTime(fileMetas, threshold);

  self.postMessage({
    type: 'done',
    groups,
    files: fileMetas,
    total
  });
};
