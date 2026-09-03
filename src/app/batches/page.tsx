'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Layers, Plus, RefreshCw, FileText, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime } from '@/lib/utils';
import type { Batch } from '@/types';

export default function BatchesPage() {
  const [batchesList, setBatchesList] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    fetch('/api/batches')
      .then((res) => res.json())
      .then((json) => {
        if (!ignore && json.success) {
          setBatchesList(json.data || []);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Error loading batches');
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [refreshKey]);

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'queued':
      case 'completed':
        return 'success';
      case 'processing':
      case 'sending':
        return 'default';
      case 'paused':
        return 'warning';
      case 'failed':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Batches</h2>
          <p className="text-sm text-muted-foreground">
            Manage your uploaded files, contact batches, and processing statistics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              setRefreshKey((k) => k + 1);
            }}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Link href="/upload">
            <Button size="sm">
              <Plus className="h-4 w-4" />
              Upload New File
            </Button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Loading batches...
          </CardContent>
        </Card>
      ) : batchesList.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={Layers}
              title="No batches uploaded yet"
              description="Upload your first CSV or PDF contact file to start organizing and staging outreach."
              action={
                <Link href="/upload">
                  <Button size="sm" className="mt-2">
                    <Plus className="h-4 w-4" />
                    Upload Contacts
                  </Button>
                </Link>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Batch & File</th>
                  <th className="px-4 py-3">Uploaded</th>
                  <th className="px-4 py-3 text-center">Total</th>
                  <th className="px-4 py-3 text-center">Relevant</th>
                  <th className="px-4 py-3 text-center">Filtered</th>
                  <th className="px-4 py-3 text-center">Duplicates</th>
                  <th className="px-4 py-3 text-center">Invalid</th>
                  <th className="px-4 py-3 text-center">Queued</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {batchesList.map((batch) => (
                  <tr key={batch.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div>
                          <p className="font-semibold text-foreground">{batch.filename}</p>
                          <p className="text-[11px] font-mono text-muted-foreground">{batch.id}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(batch.uploadDate)}
                    </td>
                    <td className="px-4 py-3 text-center font-medium text-foreground">
                      {batch.totalRecords}
                    </td>
                    <td className="px-4 py-3 text-center font-medium text-emerald-600">
                      {batch.relevantCompanies}
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">
                      {batch.irrelevantCompanies}
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">
                      {batch.duplicateContacts}
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">
                      {batch.invalidEmails}
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-primary">
                      {batch.emailsPending}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={getStatusBadgeVariant(batch.status)}>
                        {batch.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/batches/${batch.id}`}>
                        <Button variant="ghost" size="sm">
                          View
                          <ArrowRight className="h-3.5 w-3.5 ml-1" />
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
