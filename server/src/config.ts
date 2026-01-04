import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (credentialsJson && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const candidatePaths = ['/tmp/gcp-creds.json'];
  const targetPath = candidatePaths[0]!;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(credentialsJson);
    } catch {
      const decoded = Buffer.from(credentialsJson, 'base64').toString('utf-8');
      parsed = JSON.parse(decoded);
    }
    fs.writeFileSync(targetPath, JSON.stringify(parsed), { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = targetPath;
    console.log('GCP credentials loaded from GOOGLE_APPLICATION_CREDENTIALS_JSON');
  } catch (error) {
    console.warn('Failed to load GOOGLE_APPLICATION_CREDENTIALS_JSON:', (error as Error).message);
  }
}
