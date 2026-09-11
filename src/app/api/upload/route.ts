import { NextRequest, NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { processBatchFile } from '@/lib/pipeline/batch-processor';
import { reconcilePendingClassifications } from '@/lib/pipeline/classification-reconciler';
import type { ApiResponse } from '@/types';
import fs from 'fs';
import path from 'path';
import { getUploadsDir } from '@/lib/config/paths';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    ensureInitialized();

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { success: false, error: 'No file provided or invalid form field "file".' },
        { status: 400 }
      );
    }

    const filename = file instanceof File ? file.name : 'uploaded-file.csv';
    const fileSize = file.size;

    // Check size
    if (fileSize === 0) {
      return NextResponse.json(
        { success: false, error: 'Uploaded file is empty.' },
        { status: 400 }
      );
    }

    if (fileSize > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { success: false, error: `File size exceeds 10 MB limit (${(fileSize / (1024 * 1024)).toFixed(2)} MB).` },
        { status: 400 }
      );
    }

    // Check extension
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    if (ext !== '.csv' && ext !== '.xlsx') {
      return NextResponse.json(
        { success: false, error: 'Unsupported file type. Only CSV (.csv) and Excel (.xlsx) files are allowed.' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save copy safely in DATA_DIR/uploads/
    const uploadsDir = getUploadsDir();
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const sanitizedBase = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const safeFilename = `${Date.now()}_${sanitizedBase}`;
    const targetPath = path.join(uploadsDir, safeFilename);
    fs.writeFileSync(targetPath, buffer);

    // Process the file through the full Phase 2 pipeline
    const result = await processBatchFile(buffer, filename, targetPath);

    // Accelerate background classification for this batch without blocking the HTTP response.
    // The persistent worker loop remains the durable fallback.
    reconcilePendingClassifications(undefined, { batchId: result.batchId }).catch((err) => {
      console.warn(`[Upload API] Notice during asynchronous classification trigger for ${result.batchId}:`, err);
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('File upload error:', error);
    const msg = error instanceof Error ? error.message : 'File processing encountered an error.';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
