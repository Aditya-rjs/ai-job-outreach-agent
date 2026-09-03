'use client';

import { useState, useRef } from 'react';
import {
  Upload as UploadIcon,
  FileSpreadsheet,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';

interface UploadResult {
  batchId: string;
  filename: string;
  totalRecords: number;
  validRecords: number;
  relevantCompanies: number;
  irrelevantCompanies: number;
  duplicateContacts: number;
  invalidEmails: number;
  emailsPending: number;
  status: string;
}

export default function UploadPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const validateAndSelectFile = (file: File) => {
    setErrorMessage(null);
    setUploadResult(null);

    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    if (ext !== '.csv' && ext !== '.pdf') {
      setErrorMessage(`Invalid file format "${ext}". Only CSV and PDF files are supported.`);
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setErrorMessage(
        `File size exceeds 10 MB limit (${(file.size / (1024 * 1024)).toFixed(2)} MB).`
      );
      return;
    }

    if (file.size === 0) {
      setErrorMessage('The selected file is empty.');
      return;
    }

    setSelectedFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      validateAndSelectFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      validateAndSelectFile(e.target.files[0]);
    }
  };

  const handleUploadAndProcess = async () => {
    if (!selectedFile) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setCurrentStep('Uploading document to server...');

    const stepTimer1 = setTimeout(() => setCurrentStep('Parsing file and detecting headers...'), 800);
    const stepTimer2 = setTimeout(() => setCurrentStep('Normalizing contact data & checking emails...'), 2000);
    const stepTimer3 = setTimeout(() => setCurrentStep('Evaluating company relevance for CS/IT outreach...'), 3500);
    const stepTimer4 = setTimeout(() => setCurrentStep('Applying global deduplication & staging queue...'), 5000);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();

      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      clearTimeout(stepTimer3);
      clearTimeout(stepTimer4);

      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to process file.');
      }

      setCurrentStep('Completed!');
      setUploadResult(json.data);
    } catch (err: unknown) {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      clearTimeout(stepTimer3);
      clearTimeout(stepTimer4);
      setErrorMessage(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    setUploadResult(null);
    setErrorMessage(null);
    setCurrentStep('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Upload Contacts</h2>
        <p className="text-sm text-muted-foreground">
          Upload CSV or PDF files containing recruiter contact information. We automatically extract,
          deduplicate, filter for CS/IT relevance, and queue eligible contacts.
        </p>
      </div>

      {/* Error alert */}
      {errorMessage && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold">Processing Error</p>
            <p className="mt-0.5">{errorMessage}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setErrorMessage(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Processing State Card */}
      {isProcessing && (
        <Card className="border-primary/30 bg-primary/[0.02]">
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center space-y-4">
              <Loader2 className="h-10 w-10 text-primary animate-spin" />
              <div>
                <h3 className="text-lg font-semibold text-foreground">Processing File</h3>
                <p className="text-sm text-primary font-medium mt-1">{currentStep}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Analyzing {selectedFile?.name} ({(selectedFile ? selectedFile.size / 1024 : 0).toFixed(1)} KB)
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Success Result Card */}
      {uploadResult && !isProcessing && (
        <Card className="border-emerald-200 bg-emerald-50/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-emerald-100 p-2">
                  <CheckCircle2 className="h-6 w-6 text-emerald-600" />
                </div>
                <div>
                  <CardTitle className="text-emerald-950">File Processed Successfully</CardTitle>
                  <CardDescription>
                    Batch <span className="font-mono font-medium">{uploadResult.batchId}</span> — {uploadResult.filename}
                  </CardDescription>
                </div>
              </div>
              <Badge variant="success">Staged in Queue</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Metric counters */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-border bg-card p-3 text-center">
                <p className="text-xs text-muted-foreground">Total Records</p>
                <p className="text-xl font-bold text-foreground mt-0.5">{uploadResult.totalRecords}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 text-center">
                <p className="text-xs text-muted-foreground">Valid Records</p>
                <p className="text-xl font-bold text-foreground mt-0.5">{uploadResult.validRecords}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 text-center">
                <p className="text-xs text-muted-foreground">Relevant Companies</p>
                <p className="text-xl font-bold text-emerald-600 mt-0.5">{uploadResult.relevantCompanies}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 text-center">
                <p className="text-xs text-muted-foreground">Eligible Queued</p>
                <p className="text-xl font-bold text-primary mt-0.5">{uploadResult.emailsPending}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 text-xs">
              <div className="rounded-lg border border-border bg-card/60 p-2.5 text-center">
                <span className="text-muted-foreground">Filtered Non-Tech:</span>{' '}
                <span className="font-semibold text-foreground">{uploadResult.irrelevantCompanies}</span>
              </div>
              <div className="rounded-lg border border-border bg-card/60 p-2.5 text-center">
                <span className="text-muted-foreground">Duplicate Emails:</span>{' '}
                <span className="font-semibold text-foreground">{uploadResult.duplicateContacts}</span>
              </div>
              <div className="rounded-lg border border-border bg-card/60 p-2.5 text-center">
                <span className="text-muted-foreground">Invalid Syntax:</span>{' '}
                <span className="font-semibold text-foreground">{uploadResult.invalidEmails}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <Button variant="outline" size="sm" onClick={handleReset}>
                <RefreshCw className="h-4 w-4" />
                Upload Another File
              </Button>
              <div className="flex gap-2">
                <Link href={`/batches/${uploadResult.batchId}`}>
                  <Button size="sm">
                    View Processed Batch
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Upload Card */}
      {!uploadResult && !isProcessing && (
        <Card>
          <CardContent className="pt-6">
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                dragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/40 bg-card'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.pdf,text/csv,application/pdf"
                className="hidden"
                onChange={handleFileInputChange}
              />

              <div className="rounded-full bg-primary/10 p-4 mb-3">
                <UploadIcon className="h-8 w-8 text-primary" />
              </div>

              {selectedFile ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-foreground">{selectedFile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(selectedFile.size / 1024).toFixed(1)} KB —{' '}
                    {selectedFile.name.endsWith('.csv') ? 'CSV Spreadsheet' : 'PDF Document'}
                  </p>
                  <div className="flex gap-2 justify-center pt-2">
                    <Button size="sm" onClick={handleUploadAndProcess}>
                      Process Contacts
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleReset}>
                      Change File
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-foreground">
                    Drag and drop your file here
                  </h3>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    Supports CSV spreadsheets and PDF contact documents up to 10 MB. Inconsistent
                    columns and headers are automatically detected and mapped.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Browse Local Files
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Supported Formats Guide */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-emerald-50 p-2">
                <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <CardTitle className="text-base">CSV Files</CardTitle>
                <CardDescription>Comma, semicolon, or tab-delimited files</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-1.5">
            <p>• Automatically handles messy column headers (e.g. &ldquo;Company Name&rdquo;, &ldquo;HR Email&rdquo;, &ldquo;Recruiter&rdquo;).</p>
            <p>• Strips phone numbers, physical addresses, and unrelated fields.</p>
            <p>• Normalizes and deduplicates emails globally across all files.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-red-50 p-2">
                <FileText className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <CardTitle className="text-base">PDF Documents</CardTitle>
                <CardDescription>Text and scanned PDFs with OCR</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-1.5">
            <p>• Extracts text from digital and tabular PDF contact lists.</p>
            <p>• Automatically applies OCR fallback for image-based or scanned PDFs.</p>
            <p>• Preserves company name, contact person, and verified email address.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
