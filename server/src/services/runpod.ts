
import axios from 'axios';

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const CALLBACK_BASE_URL = process.env.CALLBACK_BASE_URL || 'https://api.yourdomain.com';

if (!RUNPOD_API_KEY) {
  console.warn('RUNPOD_API_KEY is not set');
}

if (!RUNPOD_ENDPOINT_ID) {
  console.warn('RUNPOD_ENDPOINT_ID is not set. HDR jobs will fail.');
}

interface RunpodInput {
  jobId: string;
  groupId: string;
  files: Array<{
    r2_bucket: string;
    r2_key: string;
    r2_key_raw?: string; // Compatibility
    id: string;
  }>;
  callbackUrl?: string;
  callbackSecret?: string;
}

export const submitHdrJobToRunpod = async (input: RunpodInput) => {
  if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
    throw new Error('RunPod configuration missing (API Key or Endpoint ID)');
  }

  const url = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`;
  
  // Construct the webhook URL if not provided
  // We'll append the job/group IDs to query params for extra context if needed, 
  // but the payload usually carries it.
  const webhookUrl = input.callbackUrl || `${CALLBACK_BASE_URL}/api/webhooks/runpod/hdr`;

  const payload = {
    input: {
      ...input,
      callbackUrl: webhookUrl,
      // Pass a secret to verify the webhook comes from us (optional but good practice)
      callbackSecret: process.env.RUNPOD_CALLBACK_SECRET || 'mvai-secret'
    },
    webhook: webhookUrl // RunPod native webhook
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RUNPOD_API_KEY}`
      }
    });

    return response.data; // { id: "taskId", status: "IN_QUEUE" }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('RunPod submission error:', error.response?.data);
      throw new Error(`RunPod API Error: ${error.response?.data?.error || error.message}`);
    }
    throw error;
  }
};
