# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Commands

### Node/Next.js application

- Install dependencies:

```bash
npm install
```

- Run the development server (Next.js app router on port 3000):

```bash
npm run dev
```

- Build the production bundle:

```bash
npm run build
```

- Start the production server (after `npm run build`):

```bash
npm run start
```

- Lint the project with ESLint:

```bash
npm run lint
```

- Tests: there is currently no `test` script configured in `package.json`, so no test runner is set up yet.

### Python worker

The `worker/worker.py` script is a long-running background worker that processes Supabase jobs via ComfyUI.

- Ensure your Python environment has at least:
  - `requests`
  - `supabase-py` (imported as `supabase`)

- Required environment variables for the worker:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `IMAGES_BUCKET` (optional, defaults to `"images"` in code)
  - `COMFY_URL` (optional, defaults to `"http://127.0.0.1:8188"`)
  - `COMFY_INPUT_DIR` (optional, defaults to `"/workspace/runpod-slim/ComfyUI/input"`)
  - `COMFY_OUTPUT_DIR` (optional, defaults to `"/workspace/runpod-slim/ComfyUI/output"`)

- Run the worker from the repository root (after exporting the needed environment variables):

```bash
python worker/worker.py
```

The worker expects a `comfy_workflow.json` file next to `worker.py` and uses it as the base ComfyUI workflow.

## Architecture Overview

### High-level structure

This repository contains two main pieces:

1. A Next.js app-router frontend in the `app/` directory.
2. A Python background worker in `worker/worker.py` that integrates Supabase Storage, Supabase tables, and a ComfyUI instance.

### Frontend (Next.js app router)

- **Global layout** (`app/layout.tsx`):
  - Configures the root HTML shell and global fonts using `next/font` (Geist families).
  - Imports `app/globals.css`, which in turn imports Tailwind CSS v4 and defines theme variables for background/foreground colors and fonts.

- **Routes**:
  - `/` (`app/page.tsx`): Default landing page generated from the Next.js template, currently a marketing/placeholder page.
  - `/auth` (`app/auth/page.tsx`):
    - Client-side React page (`'use client'`).
    - Implements email/password authentication via `supabase.auth` with two modes:
      - `signup` → `auth.signUp({ email, password })`.
      - `login` → `auth.signInWithPassword({ email, password })`.
    - Shows messages returned from Supabase (e.g., registration success, login success or error text).
  - `/dashboard` (`app/dashboard/page.tsx`):
    - Client-side React page (`'use client'`).
    - On mount, calls `supabase.auth.getUser()` and redirects to `/auth` if there is no signed-in user.
    - Loads the current user’s **projects** and **jobs** from Supabase:
      - `projects` table: filtered by `user_id`, ordered by `created_at` desc.
      - `jobs` table: filtered by `user_id`, ordered by `created_at` desc.
    - Manages UI state for:
      - The current user’s email and ID.
      - A list of `projects` (each with `id`, `name`, `created_at`).
      - A list of `jobs` (each with `id`, `input_path`, `status`, `created_at`, optional `output_path`, `project_id`, `error_message`).
      - The selected project and the name for a new project.
    - **Project management**:
      - Creates new projects by inserting `{ user_id, name }` into the `projects` table.
      - Lets the user select a project, which then scopes the jobs view and downloads.
    - **Upload flow**:
      - Validates that the user is logged in and a project is selected.
      - For each selected image file:
        - Normalizes the filename into a filesystem-safe `safeName`.
        - Uploads the file to Supabase Storage bucket `images` at key `user/{userId}/{timestamp}-{safeName}`.
        - Inserts a new row in the `jobs` table with:
          - `user_id`
          - `input_path` (storage key)
          - `status` set to `'uploaded'`
          - `project_id` set to the current project
      - Prepends newly created jobs to local state and notifies the user.
    - **Job list and actions**:
      - Displays jobs filtered by the selected project (or all jobs if no project is selected).
      - Status text mapping:
        - `'uploaded'` → pending processing.
        - `'processing'` → in progress.
        - `'done'` → completed.
        - `'failed'` → processing failed.
      - For each job:
        - If status is `'done'` and `output_path` is set, it generates a signed URL from the `images` bucket and opens it in a new tab for download.
        - If status is `'failed'`, it updates the job back to `status = 'uploaded'` and clears `error_message` so the worker can re-process it.
      - Includes a top-level action to download all completed images for the selected project by iterating over matching jobs and opening signed URLs for each.

- **Supabase client (frontend)** (`lib/supabaseClient.ts`):
  - Creates a single shared Supabase client with `createClient` from `@supabase/supabase-js`.
  - Uses public environment variables:
    - `NEXT_PUBLIC_SUPABASE_URL`
    - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - Any code that needs Supabase in the frontend imports `supabase` from this module.

### Background worker (Python + Supabase + ComfyUI)

- **Configuration** (`worker/worker.py`):
  - Reads core configuration from environment variables:
    - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` for a Supabase **service role** client.
    - `IMAGES_BUCKET` (default: `"images"`).
    - `COMFY_URL` (default: `"http://127.0.0.1:8188"`).
    - `COMFY_INPUT_DIR` (default: `"/workspace/runpod-slim/ComfyUI/input"`).
    - `COMFY_OUTPUT_DIR` (default: `"/workspace/runpod-slim/ComfyUI/output"`).
  - Loads a base ComfyUI workflow JSON from `comfy_workflow.json` in the same directory.

- **Job lifecycle**:
  - `fetch_next_job()`:
    - Selects the newest job where `status = 'uploaded'` from the `jobs` table.
    - Attempts to atomically update that job’s status to `'processing'` with a conditional update on `status = 'uploaded'` to avoid double-processing in multi-worker setups.
  - `download_input(job)`:
    - Downloads the original image from Supabase Storage bucket `images` using `job["input_path"]`.
    - Saves it under `/tmp/jobs` with a name based on the job ID.
  - `process_image(local_input)`:
    - Copies the local input image into the ComfyUI input directory.
    - Deep-copies the loaded base workflow.
    - Sets the `image` input on the `LoadImage` node (hard-coded node key `"31"`) to the filename just copied.
    - Sets the output file naming on the `SaveImagePlusV2` node (key `"41"`):
      - Clears any custom path so it uses the default ComfyUI output directory.
      - Sets `custom_filename` to `<input_stem>_edited`.
      - Forces `format` to `"jpg"`.
    - Submits the workflow to ComfyUI via `POST {COMFY_URL}/prompt` and waits for an output file named `<input_stem>_edited.jpg` to appear in `COMFY_OUTPUT_DIR`.
  - `upload_output(job, local_output)`:
    - Uploads the processed image back to the `images` bucket at key `user/{user_id}/{job_id}-output{ext}`.
    - Returns the `output_path` string used by the dashboard to generate signed download URLs.
  - `mark_done(job_id, output_path)`:
    - Updates the corresponding `jobs` row with `status = 'done'` and `output_path`.

- **Main loop** (`main_loop`):
  - Runs indefinitely:
    - Polls for the next `uploaded` job.
    - If none is found, sleeps briefly and retries.
    - For each job:
      - Downloads the input image.
      - Processes it via ComfyUI.
      - Uploads the output image.
      - Marks the job as `done`.
    - Catches any exception, logs it, sleeps, and continues.

### Data and flow summary

- **User authentication**:
  - Frontend uses Supabase’s JS client with anon key to handle login and signup on `/auth`.

- **Projects**:
  - Stored in a `projects` table with at least `id`, `user_id`, `name`, and `created_at`.
  - Used to group jobs (image editing tasks) under a human-readable label such as a property address.

- **Jobs**:
  - Stored in a `jobs` table with at least:
    - `id`, `user_id`, `project_id`.
    - `input_path` (original image storage key).
    - `status` (`uploaded`, `processing`, `done`, `failed`).
    - `output_path` (result image storage key, set when processing is complete).
    - `created_at` and optional `error_message`.
  - Frontend writes new `uploaded` jobs; the Python worker consumes them and transitions them to `processing` and then `done`.

- **Storage bucket**:
  - All image I/O flows through a Supabase Storage bucket named `images` by default.
  - Frontend uploads user images and lists jobs; the worker reads those originals and writes processed versions back, which the dashboard exposes via signed URLs for download.
