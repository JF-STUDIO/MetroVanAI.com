
import { jobService } from '../services/jobService';
import axios from 'axios';

interface FileToUpload {
    file: File;
    id: string; // internal UUID
    name: string;
    size: number;
    type: string;
}

interface GroupData {
    id: string;
    files: FileToUpload[];
    groupIndex?: number;
}

export const processManifestSubmission = async (
    jobId: string,
    groups: GroupData[],
    onProgress?: (progress: number, status: string) => void
) => {
    try {
        // 1. Collect all files to upload
        const allFiles: FileToUpload[] = [];
        const fileMap = new Map<string, FileToUpload>();

        for (const group of groups) {
            for (const f of group.files) {
                if (!fileMap.has(f.id)) {
                    fileMap.set(f.id, f);
                    allFiles.push(f);
                }
            }
        }

        if (allFiles.length === 0) {
            throw new Error('No files to upload');
        }

        // 2. Get Presigned URLs
        if (onProgress) onProgress(10, 'Preparing upload...');

        // We map internal ID to r2_key later.
        // getPresignedRawUploadUrls takes { name, type, size }
        // It returns { signedUrls: [{ url, key, fileIndex? }], ... }
        // We need to match them back. The API usually returns them in order or with identifiers.
        // Let's check jobService implementation expectation or backend implementation.
        // Backend (jobs.ts/presign-raw) usually maps by index.

        const plainFilesForSigning = allFiles.map(f => ({
            name: f.name,
            type: f.type,
            size: f.size
        }));

        // Chunking might be needed if too many files, but let's assume < 100 for now or implement chunking.
        const CHUNK_SIZE = 50;
        const uploadResults: { id: string, r2_key: string }[] = [];

        for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) {
            const chunk = allFiles.slice(i, i + CHUNK_SIZE);
            const chunkPlain = plainFilesForSigning.slice(i, i + CHUNK_SIZE);

            const presignedData = await jobService.getPresignedRawUploadUrls(jobId, chunkPlain);
            // presignedData: { urls: [ { url, key, filename } ] }

            if (!presignedData || !Array.isArray(presignedData.urls)) {
                throw new Error('Failed to get presigned URLs');
            }

            // 3. Upload to R2
            // Parallel uploads
            const uploadPromises = chunk.map((fileObj, idx) => {
                const presigned = presignedData.urls[idx];
                if (!presigned || !presigned.url) {
                    throw new Error(`Missing presigned URL for ${fileObj.name}`);
                }

                return axios.put(presigned.url, fileObj.file, {
                    headers: {
                        'Content-Type': fileObj.type
                    },
                    onUploadProgress: (_progressEvent) => {
                        // We could track individual progress here
                    }
                }).then(() => ({
                    id: fileObj.id,
                    r2_key: presigned.key // Backend provided key
                }));
            });

            if (onProgress) onProgress(20 + Math.floor((i / allFiles.length) * 60), `Uploading batch ${Math.ceil(i / CHUNK_SIZE) + 1}...`);

            const results = await Promise.all(uploadPromises);
            uploadResults.push(...results);
        }

        // 4. Construct Manifest
        if (onProgress) onProgress(90, 'Submitting manifest...');

        const keyMap = new Map(uploadResults.map(r => [r.id, r.r2_key]));

        const manifestGroups = groups.map((g, idx) => ({
            id: g.id,
            groupIndex: g.groupIndex ?? (idx + 1),
            files: g.files.map(f => ({
                r2_key: keyMap.get(f.id),
                filename: f.name,
                size: f.size,
                // We can calculate/extract EXIF here if needed, or assume it was done during grouping
                // and passed in. Ideally `g.files` contains exif data if we extended `FileToUpload` or GroupData.
                // For now, minimal payload.
                // If the local grouping logic has EXIF, we should pass it.
            }))
        }));

        // 5. Submit Manifest
        await jobService.submitManifest({
            jobId, // Use existing Job ID
            workflowId: 'default', // or passed in
            projectName: 'Project ' + jobId, // or passed in
            groups: manifestGroups
        });

        if (onProgress) onProgress(100, 'Done');
        return true;

    } catch (error) {
        console.error('Manifest Submission Failed:', error);
        throw error;
    }
};
