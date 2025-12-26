export interface User {
  id: string;
  email: string;
  name: string;
  points: number;
  isAdmin: boolean;
}

export interface PhotoTool {
  id: string;
  name: string;
  description: string;
  workflow_id: string;
  input_node_key: string;
  point_cost: number;
  preview_url?: string;
  is_active?: boolean;
  preview_original?: string;
  preview_processed?: string;
}

export interface Job {
  id: string;
  user_id: string;
  tool_id: string;
  project_name?: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
  error_message?: string;
  zip_key?: string;
  expires_at?: string;
  created_at: string;
  photo_tools: { name: string }; // For joins
}

export interface JobAsset {
  id: string;
  job_id: string;
  r2_key: string;
  r2_output_key?: string;
  status: 'pending' | 'processing' | 'processed' | 'failed';
}
