import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { r2Client } from './r2.js';
import { exiftool } from 'exiftool-vendored';

const RAW_EXTENSIONS = new Set([
  'arw',
  'cr2',
  'cr3',
  'nef',
  'dng',
  'raf',
  'rw2',
  'orf'
]);

const runCommand = (command: string, args: string[], options: { cwd?: string } = {}) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed: ${stderr.trim()}`));
      }
    });
  });

const runCommandToFile = (command: string, args: string[], outputPath: string, options: { cwd?: string } = {}) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    const output = createWriteStream(outputPath);
    pipeline(child.stdout, output)
      .then(() => undefined)
      .catch((err) => {
        stderr += err instanceof Error ? err.message : String(err);
      });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed: ${stderr.trim()}`));
      }
    });
  });

const resolveBinary = async (name: string) => {
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn('which', [name], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (data) => {
        out += data.toString();
      });
      child.stderr.on('data', (data) => {
        err += data.toString();
      });
      child.on('close', (code) => {
        if (code === 0 && out.trim()) {
          resolve({ stdout: out.trim() });
        } else {
          reject(new Error(err.trim() || 'not found'));
        }
      });
    });
    return stdout;
  } catch {
    const candidates = [
      `/Applications/Hugin/Hugin.app/Contents/MacOS/${name}`,
      `/Applications/Hugin/tools_mac/${name}`,
      `/Applications/Hugin/PTBatcherGUI.app/Contents/MacOS/${name}`
    ];
    for (const candidate of candidates) {
      try {
        await fs.stat(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }
};

const isRawFile = (filePath: string) => {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return RAW_EXTENSIONS.has(ext);
};

const ensureExiftoolShutdown = (() => {
  let registered = false;
  return () => {
    if (registered) return;
    registered = true;
    const shutdown = () => {
      exiftool.end().catch(() => undefined);
    };
    process.on('exit', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  };
})();

const fileExists = async (filePath: string) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
};

const extractEmbeddedJpeg = async (inputPath: string, outputPath: string) => {
  ensureExiftoolShutdown();
  try {
    await fs.rm(outputPath, { force: true });
    await exiftool.extractJpgFromRaw(inputPath, outputPath);
  } catch {
    // ignore and fallback
  }

  if (await fileExists(outputPath)) {
    return true;
  }

  try {
    await fs.rm(outputPath, { force: true });
    await exiftool.extractPreview(inputPath, outputPath);
  } catch {
    return false;
  }

  return fileExists(outputPath);
};

const extractDcrawThumbnail = async (inputPath: string, outputPath: string) => {
  const dcraw = await resolveBinary('dcraw');
  if (!dcraw) return false;
  try {
    await fs.rm(outputPath, { force: true });
    await runCommandToFile(dcraw, ['-e', '-c', inputPath], outputPath);
  } catch {
    return false;
  }
  return fileExists(outputPath);
};

const downloadObject = async (bucket: string, key: string, dest: string) => {
  const { Body } = await r2Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body || typeof (Body as NodeJS.ReadableStream).pipe !== 'function') {
    throw new Error('R2 object body is not a readable stream');
  }
  await pipeline(Body as NodeJS.ReadableStream, createWriteStream(dest));
};

const convertRawToTiff = async (inputPath: string, outputPath: string) => {
  const rawtherapee = await resolveBinary('rawtherapee-cli');
  if (rawtherapee) {
    await runCommand(rawtherapee, ['-o', outputPath, '-Y', '-c', inputPath]);
    return;
  }

  const dcraw = await resolveBinary('dcraw');
  if (!dcraw) {
    throw new Error('RAW conversion tools not installed (rawtherapee-cli or dcraw)');
  }

  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  const stem = path.parse(inputPath).name;
  await runCommand(dcraw, ['-6', '-T', '-W', '-o', '1', '-q', '3', inputPath], { cwd: dir });
  const candidates = [
    path.join(dir, `${base}.tiff`),
    path.join(dir, `${base}.tif`),
    path.join(dir, `${base}.TIFF`),
    path.join(dir, `${base}.TIF`),
    path.join(dir, `${stem}.tiff`),
    path.join(dir, `${stem}.tif`),
    path.join(dir, `${stem}.TIFF`),
    path.join(dir, `${stem}.TIF`)
  ];
  let generatedPath: string | null = null;

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      generatedPath = candidate;
      break;
    }
  }

  if (!generatedPath) {
    const files = await fs.readdir(dir);
    const lowerBase = base.toLowerCase();
    const lowerStem = stem.toLowerCase();
    const match = files.find((name) => {
      const lower = name.toLowerCase();
      return (
        lower === `${lowerBase}.tiff` ||
        lower === `${lowerBase}.tif` ||
        lower === `${lowerStem}.tiff` ||
        lower === `${lowerStem}.tif`
      );
    });
    if (match) {
      generatedPath = path.join(dir, match);
    }
  }

  if (!generatedPath) {
    throw new Error('RAW conversion output not found');
  }

  await fs.copyFile(generatedPath, outputPath);
  if (generatedPath !== outputPath) {
    await fs.rm(generatedPath, { force: true });
  }
};

export const convertToJpeg = async (inputPath: string, outputPath: string) => {
  const magick = (await resolveBinary('magick')) || (await resolveBinary('convert'));
  if (!magick) {
    throw new Error('ImageMagick is not installed (magick/convert)');
  }
  await runCommand(magick, [inputPath, '-quality', '92', outputPath]);
};

export const createRawPreview = async (inputPath: string, outputPath: string) => {
  if (!isRawFile(inputPath)) {
    await convertToJpeg(inputPath, outputPath);
    return;
  }

  const extracted = await extractEmbeddedJpeg(inputPath, outputPath);
  if (extracted) return;

  const dcrawThumb = await extractDcrawThumbnail(inputPath, outputPath);
  if (dcrawThumb) return;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvai-preview-'));
  try {
    const tiffPath = path.join(tempDir, 'preview.tif');
    await convertRawToTiff(inputPath, tiffPath);
    await convertToJpeg(tiffPath, outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const alignAndFuse = async (inputPaths: string[], outputPath: string, workDir: string) => {
  const align = await resolveBinary('align_image_stack');
  const enfuse = await resolveBinary('enfuse');

  if (!align || !enfuse) {
    throw new Error('HDR alignment tools not installed (align_image_stack/enfuse)');
  }

  const alignedPrefix = path.join(workDir, 'aligned_');
  await runCommand(align, ['-a', alignedPrefix, ...inputPaths]);

  const alignedFiles = (await fs.readdir(workDir))
    .filter((name) => name.startsWith('aligned_') && name.endsWith('.tif'))
    .map((name) => path.join(workDir, name));

  if (alignedFiles.length === 0) {
    throw new Error('HDR alignment produced no output');
  }

  const fusedPath = path.join(workDir, 'fused.tif');
  await runCommand(enfuse, ['-o', fusedPath, ...alignedFiles]);
  await convertToJpeg(fusedPath, outputPath);
};

const pickFallbackJpeg = (paths: string[]) => {
  if (!paths.length) return null;
  const mid = Math.floor((paths.length - 1) / 2);
  return paths[mid];
};

export type HdrSource = {
  bucket: string;
  key: string;
};

export const createHdrForGroup = async (sources: HdrSource[], outputName: string) => {
  if (sources.length === 0) {
    throw new Error('No sources provided for HDR');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvai-hdr-'));
  const localPaths: string[] = [];

  try {
    for (const source of sources) {
      const fileName = path.basename(source.key);
      const localPath = path.join(tempDir, fileName);
      await downloadObject(source.bucket, source.key, localPath);
      localPaths.push(localPath);
    }

    const outputPath = path.join(tempDir, outputName);

    if (localPaths.length === 1) {
      const onlyPath = localPaths[0];
      if (isRawFile(onlyPath)) {
        const embeddedPath = path.join(tempDir, `${path.parse(onlyPath).name}_embedded.jpg`);
        const extracted = await extractEmbeddedJpeg(onlyPath, embeddedPath);
        if (extracted) {
          await fs.copyFile(embeddedPath, outputPath);
          return { outputPath, tempDir };
        }

        const tiffPath = path.join(tempDir, `${path.parse(onlyPath).name}.tiff`);
        await convertRawToTiff(onlyPath, tiffPath);
        await convertToJpeg(tiffPath, outputPath);
      } else {
        const ext = path.extname(onlyPath).toLowerCase();
        if (ext === '.jpg' || ext === '.jpeg') {
          await fs.copyFile(onlyPath, outputPath);
        } else {
          await convertToJpeg(onlyPath, outputPath);
        }
      }
      return { outputPath, tempDir };
    }

    const jpegInputs: string[] = [];
    const rawInputs: string[] = [];

    for (const localPath of localPaths) {
      if (isRawFile(localPath)) {
        const embeddedPath = path.join(tempDir, `${path.parse(localPath).name}_embedded.jpg`);
        const extracted = await extractEmbeddedJpeg(localPath, embeddedPath);
        if (extracted) {
          jpegInputs.push(embeddedPath);
        } else {
          rawInputs.push(localPath);
        }
      } else {
        jpegInputs.push(localPath);
      }
    }

    if (jpegInputs.length >= 2 && rawInputs.length === 0) {
      await alignAndFuse(jpegInputs, outputPath, tempDir);
      return { outputPath, tempDir };
    }

    const alignInputs: string[] = [];
    for (const localPath of localPaths) {
      if (isRawFile(localPath)) {
        const tiffPath = path.join(tempDir, `${path.parse(localPath).name}.tiff`);
        await convertRawToTiff(localPath, tiffPath);
        alignInputs.push(tiffPath);
      } else {
        alignInputs.push(localPath);
      }
    }

    await alignAndFuse(alignInputs, outputPath, tempDir);
    return { outputPath, tempDir };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
};

export const cleanupHdrTemp = async (tempDir: string) => {
  await fs.rm(tempDir, { recursive: true, force: true });
};
