# Load Testing (k6)

This folder contains k6 scripts for staged load tests:

- `api-baseline.js`: auth + settings + workflows + create job + status
- `upload-only.js`: create job + register groups + presign + upload (optional HDR trigger)
- `full-pipeline.js`: full flow (groups + start + upload + file_uploaded + previews)

## Prereqs

1. Install k6 (local):
   - macOS: `brew install k6`
   - Linux: https://k6.io/docs/get-started/installation/

2. Prepare a test user:
   - Must be a verified Supabase user.
   - Must have enough credits for `full-pipeline.js`.

## Environment variables

Required:

- `API_BASE_URL` (example: `http://localhost:4000/api`)
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `TEST_EMAIL`
- `TEST_PASSWORD`

Optional:

- `TEST_USERS` (comma list of `email:password`, overrides `TEST_EMAIL/TEST_PASSWORD`)
- `WORKFLOW_ID` or `WORKFLOW_SLUG`
- `VUS` and `DURATION` (default in script, or use `-u` / `-d`)
- `FILE_COUNT` (default 3)
- `FILE_SIZE_KB` (default 256)
- `RESERVE_CREDITS=true` (only for `upload-only.js`)
- `TRIGGER_HDR=true` (only for `upload-only.js`)
- `MAX_WAIT_SEC` (only for `full-pipeline.js`, default 0)

## Run examples

API baseline:
```
k6 run scripts/loadtest/api-baseline.js
```

Upload only (presign + PUT only):
```
k6 run -u 5 -d 2m scripts/loadtest/upload-only.js
```

Upload only with HDR trigger:
```
TRIGGER_HDR=true RESERVE_CREDITS=true k6 run -u 3 -d 2m scripts/loadtest/upload-only.js
```

Full pipeline:
```
MAX_WAIT_SEC=300 k6 run -u 2 -d 2m scripts/loadtest/full-pipeline.js
```

## Notes

- Always run load tests against a staging environment first.
- For `full-pipeline.js`, make sure your test user has enough credits.
- If your HDR/AI worker is not configured, `full-pipeline.js` may end with failed status.
