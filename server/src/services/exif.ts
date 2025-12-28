import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { exiftool } from 'exiftool-vendored';
import { r2Client } from './r2.js';

type ExifResult = {
  exif_time: string | null;
  camera_make: string | null;
  camera_model: string | null;
  size: number | null;
  exposure_time: number | null;
  fnumber: number | null;
  iso: number | null;
  ev: number | null;
  focal_length: number | null;
};

const parseExifDateString = (value: string): Date | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?$/);
  if (match) {
    const [, year, month, day, hour, minute, second, fraction] = match;
    const ms = fraction ? Math.round(Number(fraction) * 1000) : 0;
    const timestamp = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      ms
    );
    return new Date(timestamp);
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeExifTime = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = parseExifDateString(value);
    return parsed ? parsed.toISOString() : null;
  }
  if (typeof value === 'object') {
    const obj = value as { toDate?: () => Date; toISOString?: () => string };
    if (typeof obj.toDate === 'function') {
      const date = obj.toDate();
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof obj.toISOString === 'function') {
      return obj.toISOString();
    }
  }
  return null;
};

const downloadObject = async (bucket: string, key: string, dest: string) => {
  const { Body } = await r2Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body || typeof (Body as NodeJS.ReadableStream).pipe !== 'function') {
    throw new Error('R2 object body is not a readable stream');
  }
  await pipeline(Body as NodeJS.ReadableStream, createWriteStream(dest));
};

const parseExposureTime = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.includes('/')) {
      const [num, den] = trimmed.split('/').map(Number);
      if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
        return num / den;
      }
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const obj = value as { numerator?: number; denominator?: number };
    const numerator = obj.numerator;
    const denominator = obj.denominator;
    if (
      typeof numerator === 'number' &&
      typeof denominator === 'number' &&
      Number.isFinite(numerator) &&
      Number.isFinite(denominator) &&
      denominator !== 0
    ) {
      return numerator / denominator;
    }
  }
  return null;
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseFocalLength = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/[\d.]+/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const obj = value as { numerator?: number; denominator?: number };
    if (
      typeof obj.numerator === 'number' &&
      typeof obj.denominator === 'number' &&
      Number.isFinite(obj.numerator) &&
      Number.isFinite(obj.denominator) &&
      obj.denominator !== 0
    ) {
      return obj.numerator / obj.denominator;
    }
  }
  return null;
};

const computeEv = (exposureTime: number | null, fnumber: number | null, iso: number | null) => {
  if (!exposureTime || !fnumber || !iso) return null;
  if (exposureTime <= 0 || fnumber <= 0 || iso <= 0) return null;
  const ev = Math.log2((fnumber ** 2) / exposureTime) - Math.log2(iso / 100);
  return Number.isFinite(ev) ? ev : null;
};

export const extractExifFromR2 = async (bucket: string, key: string): Promise<ExifResult> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvai-exif-'));
  const filePath = path.join(tempDir, path.basename(key));

  try {
    await downloadObject(bucket, key, filePath);
    const metadata = await exiftool.read(filePath);
    const stat = await fs.stat(filePath);

    const subSecDate = normalizeExifTime((metadata as any).SubSecDateTimeOriginal);
    let exifTime = subSecDate;
    if (!exifTime) {
      const rawBase =
        (metadata as any).DateTimeOriginal ||
        (metadata as any).CreateDate ||
        (metadata as any).ModifyDate;
      const baseDate =
        normalizeExifTime(rawBase) ||
        normalizeExifTime((metadata as any).DateTimeOriginal) ||
        normalizeExifTime((metadata as any).CreateDate) ||
        normalizeExifTime((metadata as any).ModifyDate);
      const subSec = (metadata as any).SubSecTimeOriginal || (metadata as any).SubSecTimeDigitized;
      if (rawBase && subSec && typeof rawBase === 'string' && typeof subSec === 'string') {
        const combined = `${rawBase}.${subSec}`;
        const parsed = parseExifDateString(combined);
        exifTime = parsed ? parsed.toISOString() : baseDate;
      } else {
        exifTime = baseDate;
      }
    }

    const exposureTime =
      parseExposureTime((metadata as any).ExposureTime) ||
      parseExposureTime((metadata as any).ShutterSpeed);
    const fnumber = parseNumber((metadata as any).FNumber) || parseNumber((metadata as any).Aperture);
    const iso = parseNumber((metadata as any).ISO) || parseNumber((metadata as any).ISOSettings);
    const focalLength = parseFocalLength((metadata as any).FocalLength);
    const ev = computeEv(exposureTime, fnumber, iso);

    return {
      exif_time: exifTime,
      camera_make: (metadata as any).Make || null,
      camera_model: (metadata as any).Model || null,
      size: stat.size || null,
      exposure_time: exposureTime,
      fnumber,
      iso,
      ev,
      focal_length: focalLength
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

let exiftoolRegistered = false;
if (!exiftoolRegistered) {
  exiftoolRegistered = true;
  const shutdown = () => {
    exiftool.end().catch(() => undefined);
  };
  process.on('exit', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
