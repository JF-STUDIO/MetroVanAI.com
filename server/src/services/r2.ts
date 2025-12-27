import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

export const getPresignedGetUrl = async (
  bucket: string,
  key: string,
  expiresIn = 900
) => {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
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
