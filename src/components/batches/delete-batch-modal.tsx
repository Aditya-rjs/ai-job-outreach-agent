'use client';

import { useState } from 'react';
import { AlertTriangle, Trash2, Loader2, X, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Batch } from '@/types';

interface DeleteBatchModalProps {
  batch: Batch | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (deletedBatch: Batch) => void;
}

export function DeleteBatchModal({
  batch,
  isOpen,
  onClose,
  onSuccess,
}: DeleteBatchModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !batch) return null;

  const hasQueued = (batch.emailsPending || 0) > 0;
  const isSendingOrSent = batch.status === 'sending' || (batch.emailsSent || 0) > 0;

  const handleClose = () => {
    if (isDeleting) return;
    setIsDeleting(false);
    setError(null);
    onClose();
  };

  const handleDelete = async () => {
    // Prevent double clicking while request is active
    if (isDeleting) return;

    setIsDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/batches/${batch.id}`, {
        method: 'DELETE',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to delete batch.');
      }

      // Reset deleting state before triggering success callback
      setIsDeleting(false);
      setError(null);
      onSuccess(batch);
    } catch (err) {
      console.error('Delete batch failed:', err);
      setIsDeleting(false);
      setError(err instanceof Error ? err.message : 'Failed to delete batch. Please try again.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-lg rounded-xl border border-red-200 bg-white p-6 shadow-2xl dark:bg-slate-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
      >
        {/* Close Button */}
        <button
          onClick={handleClose}
          disabled={isDeleting}
          className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
          aria-label="Close dialog"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header with Warning Icon */}
        <div className="flex items-start gap-3.5 mb-4">
          <div className="rounded-full bg-red-100 p-2.5 text-red-600 dark:bg-red-950/50 dark:text-red-400 shrink-0">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div>
            <h3 id="delete-modal-title" className="text-lg font-bold text-foreground">
              Delete this batch?
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              This action cannot be undone.
            </p>
          </div>
        </div>

        {/* Batch Info Card */}
        <div className="rounded-lg border border-border bg-muted/40 p-3.5 mb-4 flex items-center gap-3">
          <FileText className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground truncate">
              {batch.filename}
            </p>
            <p className="text-xs font-mono text-muted-foreground">
              ID: {batch.id} • {batch.totalRecords} contact{batch.totalRecords === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        {/* Explanatory Message */}
        <div className="space-y-2.5 text-xs sm:text-sm text-foreground mb-6">
          <p className="text-muted-foreground leading-relaxed">
            This will permanently remove the uploaded file, contacts, generated outreach emails, and queued outreach associated with this batch.
          </p>

          {hasQueued && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/40 dark:border-amber-900/50 dark:text-amber-200">
              <p className="font-semibold text-xs mb-1">Queued Outreach Warning</p>
              <p className="text-xs">
                This batch contains <strong>{batch.emailsPending}</strong> queued contact{batch.emailsPending === 1 ? '' : 's'}. Deleting it will cancel all remaining outreach from this batch.
              </p>
            </div>
          )}

          {isSendingOrSent && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900 dark:bg-red-950/40 dark:border-red-900/50 dark:text-red-200">
              <p className="font-semibold text-xs mb-1">Active Sending Notice</p>
              <p className="text-xs">
                This batch is currently being processed. Deleting it will cancel all remaining unsent contacts. A message that has already been successfully sent cannot be undone.
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 mb-4">
            {error}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClose}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={isDeleting}
            className="gap-2 bg-red-600 hover:bg-red-700 text-white shadow-sm"
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting Batch...
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" />
                Delete Batch
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
