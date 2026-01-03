import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';

const defaultBucket = process.env.R2_BUCKET_NAME || '';
export const BUCKET_NAME = defaultBucket || 'wangzhan';

export const RAW_BUCKET = process.env.R2_BUCKET_RAW || defaultBucket || 'mvai-raw';
export const HDR_BUCKET = process.env.R2_BUCKET_HDR || defaultBucket || 'mvai-hdr-temp';
export const OUTPUT_BUCKET = process.env.R2_BUCKET_OUTPUT || defaultBucket || 'mvai-output';

export const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || '',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export const getPresignedPutUrl = async (
  bucket: string,
  key: string,
  contentType: string,
  expiresIn = 3600
) => {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });
  return getSignedUrl(r2Client, command, { expiresIn });
};

export const createMultipartUpload = async (bucket: string, key: string, contentType: string) => {
  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });
  const response = await r2Client.send(command);
  return { uploadId: response.UploadId, key: response.Key };
};

export const getPresignedUploadPartUrl = async (
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 3600
) => {
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber
  });
  return getSignedUrl(r2Client, command, { expiresIn });
};

export const completeMultipartUpload = async (
  bucket: string,
  key: string,
  uploadId: string,
  parts: { ETag: string; PartNumber: number }[]
) => {
  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts }
  });
  return r2Client.send(command);
};

export const abortMultipartUpload = async (bucket: string, key: string, uploadId: string) => {
  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId
  });
  return r2Client.send(command);
};

export const getPresignedGetUrl = async (
  bucket: string,
  key: string,
  expiresIn = 900,
  filename?: string | null
) => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: filename ? `attachment; filename="${filename}"` : undefined
  });
  return getSignedUrl(r2Client, command, { expiresIn });
};

export const headObject = async (bucket: string, key: string) => {
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw err;
  }
};

export const deleteObject = async (bucket: string, key: string) => {
  await r2Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

export const deleteObjects = async (bucket: string, keys: string[]) => {
  if (!keys.length) return;
  const chunkSize = 1000;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const slice = keys.slice(i, i + chunkSize);
    await r2Client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: slice.map((key) => ({ Key: key })) }
    }));
  }
};

export const deletePrefix = async (bucket: string, prefix: string) => {
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const response = await r2Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    const contents = response.Contents || [];
    contents.forEach((item) => {
      if (item.Key) keys.push(item.Key);
    });
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  await deleteObjects(bucket, keys);
  return keys.length;
};
