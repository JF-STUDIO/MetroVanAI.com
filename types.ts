export interface User {
  id: string;
  email: string;
  name: string;
  points: number;
  isAdmin: boolean;
}

export interface Workflow {
  id: string;
  slug: string;
  display_name: string;
  description?: string;
  credit_per_unit: number;
  preview_original?: string;
  preview_processed?: string;
  is_active?: boolean;
  is_hidden?: boolean;
  sort_order?: number;
  version_id?: string | null;
  version?: number | null;
}

export interface WorkflowVersion {
  id: string;
  version: number;
  workflow_remote_id: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  runtime_config?: Record<string, unknown>;
  notes?: string | null;
  is_published?: boolean;
  created_at?: string;
}

export interface AdminWorkflow extends Workflow {
  provider_id?: string | null;
  provider_name?: string | null;
  published_version?: WorkflowVersion | null;
}

export interface Job {
  id: string;
  user_id: string;
  tool_id?: string | null;
  workflow_id?: string | null;
  workflow_version_id?: string | null;
  project_name?: string;
  input_type?: 'single' | 'hdr' | 'batch' | null;
  hdr_confidence?: number | null;
  original_filenames?: string[] | null;
  estimated_units?: number | null;
  reserved_units?: number | null;
  settled_units?: number | null;
  status: 'draft' | 'uploaded' | 'analyzing' | 'input_resolved' | 'reserved' | 'preprocessing' | 'hdr_processing' | 'workflow_running' | 'ai_processing' | 'postprocess' | 'packaging' | 'zipping' | 'completed' | 'failed' | 'canceled' | 'partial' | 'pending' | 'queued' | 'processing';
  error_message?: string;
  zip_key?: string;
  output_zip_key?: string | null;
  output_file_key?: string | null;
  output_file_name?: string | null;
  progress?: number | null;
  expires_at?: string;
  created_at: string;
  photo_tools?: { name?: string } | null;
  workflows?: { display_name?: string } | null;
}

export interface JobAsset {
  id: string;
  job_id: string;
  r2_key: string;
  r2_output_key?: string;
  status: 'pending' | 'processing' | 'processed' | 'failed';
}

export interface PipelineGroupItem {
  id: string;
  group_index: number;
  status: string;
  group_type?: string | null;
  output_filename?: string | null;
  hdr_url?: string | null;
  output_url?: string | null;
  preview_url?: string | null;
  group_size?: number | null;
  representative_index?: number | null;
  frames?: {
    id: string;
    filename: string;
    order: number;
    preview_url?: string | null;
    input_kind?: string | null;
    preview_ready?: boolean;
  }[];
  last_error?: string | null;
}

export interface PipelineStatusResponse {
  job: Job;
  groups: { total: number; success: number; failed: number };
  items?: PipelineGroupItem[];
  progress?: number;
  previews?: { total: number; ready: number };
}

export interface CreditRow {
  user_id: string;
  email: string | null;
  is_admin: boolean;
  available_credits: number;
  reserved_credits: number;
}

export interface AdminJobRow {
  id: string;
  user_id: string;
  project_name?: string | null;
  status: string;
  error_message?: string | null;
  workflow_id?: string | null;
  created_at?: string;
  group_errors?: { group_index: number; last_error: string | null }[];
}

export interface AppSettings {
  free_trial_points: number;
}
