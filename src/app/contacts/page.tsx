'use client';

import { useState, useEffect } from 'react';
import { Search, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import type { Contact } from '@/types';

export default function ContactsPage() {
  const [contactsList, setContactsList] = useState<(Contact & { batchFilename?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [totalCount, setTotalCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    const params = new URLSearchParams();
    if (searchQuery) params.append('search', searchQuery);
    if (statusFilter !== 'all') params.append('status', statusFilter);
    params.append('limit', '100');

    fetch(`/api/contacts?${params.toString()}`)
      .then((res) => res.json())
      .then((json) => {
        if (!ignore && json.success) {
          setContactsList(json.data.contacts || []);
          setTotalCount(json.data.total || 0);
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load global contacts:', err);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [searchQuery, statusFilter, refreshKey]);

  const statusOptions = [
    { key: 'all', label: 'All' },
    { key: 'queued', label: 'Queued' },
    { key: 'discovered', label: 'Discovered' },
    { key: 'skipped', label: 'Skipped / Duplicates' },
    { key: 'sent', label: 'Sent' },
    { key: 'simulated', label: 'Simulated' },
    { key: 'failed', label: 'Failed' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Global Contact History</h2>
          <p className="text-sm text-muted-foreground">
            Central repository of all contacts discovered across all uploads. The unique outreach key
            is the normalized email address.
          </p>
        </div>
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
      </div>

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5 w-full sm:w-auto">
              {statusOptions.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setStatusFilter(opt.key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    statusFilter === opt.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-80">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by company, contact name, or email..."
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Normalized Email</th>
                  <th className="px-4 py-3 text-center">Relevance</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3">Batch Source</th>
                  <th className="px-4 py-3">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-xs">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-muted-foreground">
                      Loading contacts from global database...
                    </td>
                  </tr>
                ) : contactsList.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-muted-foreground">
                      No contacts found in global history. Upload a file to populate contacts.
                    </td>
                  </tr>
                ) : (
                  contactsList.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/10 transition-colors">
                      <td className="px-4 py-3 font-semibold text-foreground">
                        {c.companyName}
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {c.contactName || '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-foreground">
                        {c.email}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {c.isRelevant === true ? (
                          <Badge variant="success">Relevant — Gemini</Badge>
                        ) : c.isRelevant === false ? (
                          <Badge variant="secondary">Not Relevant — Gemini</Badge>
                        ) : c.relevanceReason?.includes('Pending') ? (
                          <Badge variant="default" className="bg-blue-50 text-blue-700 border-blue-200">
                            Classification Pending — Retrying automatically
                          </Badge>
                        ) : (
                          <Badge variant="warning">Needs Review — Gemini</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {c.status === 'queued' && <Badge variant="default">Queued</Badge>}
                        {c.status === 'discovered' && <Badge variant="outline">Discovered</Badge>}
                        {c.status === 'skipped' && <Badge variant="secondary">Skipped</Badge>}
                        {c.status === 'sent' && <Badge variant="success">Sent</Badge>}
                        {c.status === 'simulated' && (
                          <Badge variant="warning" className="bg-amber-100 text-amber-900 border-amber-300">
                            Simulated
                          </Badge>
                        )}
                        {c.status === 'failed' && <Badge variant="destructive">Failed</Badge>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground truncate max-w-xs">
                        {c.batchFilename || c.batchId}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {formatDateTime(c.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="pt-2 text-xs text-muted-foreground text-right">
            Total records found: {totalCount}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
