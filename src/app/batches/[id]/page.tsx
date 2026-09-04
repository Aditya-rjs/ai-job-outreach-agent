'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Search,
  RefreshCw,
  Sparkles,
  Mail,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import { DeleteBatchModal } from '@/components/batches/delete-batch-modal';
import type { Batch, Contact } from '@/types';

export default function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const resolvedParams = use(params);
  const batchId = resolvedParams.id;

  const [batch, setBatch] = useState<Batch | null>(null);
  const [contactsList, setContactsList] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [totalCount, setTotalCount] = useState<number>(0);

  // Delete modal state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  // Email generation states
  const [isGeneratingBatch, setIsGeneratingBatch] = useState(false);
  const [generatingContactId, setGeneratingContactId] = useState<string | null>(null);
  const [generationFeedback, setGenerationFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Email preview modal state
  const [previewContact, setPreviewContact] = useState<Contact | null>(null);

  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    const queryParams = new URLSearchParams();
    if (filter !== 'all') queryParams.append('filter', filter);
    if (searchTerm) queryParams.append('search', searchTerm);

    Promise.all([
      fetch(`/api/batches/${batchId}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/batches/${batchId}/contacts?${queryParams.toString()}`, { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([batchJson, contactsJson]) => {
        if (!ignore) {
          if (batchJson.success) setBatch(batchJson.data);
          if (contactsJson.success) {
            setContactsList(contactsJson.data.contacts || []);
            setTotalCount(contactsJson.data.total || 0);
          }
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load batch data:', err);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [batchId, filter, searchTerm, refreshKey]);

  // Trigger batch email generation
  const handleGenerateBatch = async (forceRegenerate = false) => {
    setIsGeneratingBatch(true);
    setGenerationFeedback(null);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, forceRegenerate }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to generate emails.');
      }

      setGenerationFeedback({
        type: 'success',
        message: `Successfully generated ${json.data.generatedCount} personalized email(s). Ready for review!`,
      });
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      setGenerationFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Error generating emails.',
      });
    } finally {
      setIsGeneratingBatch(false);
    }
  };

  // Trigger regeneration for a single contact
  const handleRegenerateSingle = async (contactId: string) => {
    setGeneratingContactId(contactId);

    try {
      const res = await fetch(`/api/contacts/${contactId}/regenerate`, {
        method: 'POST',
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to regenerate email.');
      }

      // Update preview contact if open
      if (previewContact && previewContact.id === contactId) {
        setPreviewContact(json.data);
      }

      setGenerationFeedback({
        type: 'success',
        message: `Regenerated email for ${json.data.companyName} with strategy "${json.data.emailStrategy}".`,
      });
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      setGenerationFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to regenerate.',
      });
    } finally {
      setGeneratingContactId(null);
    }
  };

  const filterOptions = [
    { key: 'all', label: 'All Contacts' },
    { key: 'generated', label: 'Generated Emails' },
    { key: 'queued', label: 'Queued (Pending Gen)' },
    { key: 'relevant', label: 'Relevant Companies' },
    { key: 'irrelevant', label: 'Filtered Non-Tech' },
    { key: 'unverified', label: 'Needs Review' },
    { key: 'duplicate', label: 'Duplicates' },
    { key: 'failed', label: 'Failed' },
  ];

  return (
    <div className="space-y-6">
      {/* Top breadcrumb navigation */}
      <div className="flex items-center gap-3">
        <Link href="/batches">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Back to Batches
          </Button>
        </Link>
      </div>

      {/* Batch Header info & Action buttons */}
      {batch && (
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold text-foreground">{batch.filename}</h2>
              <Badge variant={batch.status === 'queued' ? 'success' : 'secondary'}>
                {batch.status}
              </Badge>
            </div>
            <p className="text-xs font-mono text-muted-foreground mt-1">
              Batch ID: {batch.id} • Uploaded {formatDateTime(batch.uploadDate)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true);
                setRefreshKey((k) => k + 1);
              }}
              disabled={loading || isGeneratingBatch}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>

            <Button
              size="sm"
              onClick={() => handleGenerateBatch(false)}
              disabled={isGeneratingBatch || loading}
              className="gap-1.5"
            >
              {isGeneratingBatch ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating Emails...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Generate AI Emails
                </>
              )}
            </Button>

            <Button
              variant="destructive"
              size="sm"
              onClick={() => setIsDeleteModalOpen(true)}
              disabled={loading || isGeneratingBatch}
              className="gap-1.5 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 border border-red-200"
            >
              <Trash2 className="h-4 w-4" />
              Delete Batch
            </Button>
          </div>
        </div>
      )}

      {/* Feedback banner */}
      {generationFeedback && (
        <div
          className={`flex items-start gap-2.5 rounded-lg border p-3.5 text-xs ${
            generationFeedback.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {generationFeedback.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
          )}
          <div className="flex-1">{generationFeedback.message}</div>
          <button
            onClick={() => setGenerationFeedback(null)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Stats Cards */}
      {batch && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Total Rows</p>
            <p className="text-2xl font-bold text-foreground mt-1">{batch.totalRecords}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Valid Contacts</p>
            <p className="text-2xl font-bold text-foreground mt-1">{batch.validRecords}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Relevant Tech</p>
            <p className="text-2xl font-bold text-emerald-600 mt-1">{batch.relevantCompanies}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Filtered Non-Tech</p>
            <p className="text-2xl font-bold text-muted-foreground mt-1">{batch.irrelevantCompanies}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Duplicates</p>
            <p className="text-2xl font-bold text-amber-600 mt-1">{batch.duplicateContacts}</p>
          </div>
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
            <p className="text-xs font-medium text-primary">Eligible Contacts</p>
            <p className="text-2xl font-bold text-primary mt-1">{batch.emailsPending}</p>
          </div>
        </div>
      )}

      {/* Filter and Search Bar */}
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            {/* Filter buttons */}
            <div className="flex flex-wrap gap-1.5 w-full sm:w-auto">
              {filterOptions.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setFilter(opt.key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    filter === opt.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Search input */}
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search company, name, email..."
                className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          {/* Contacts Table */}
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3 text-center">Relevance</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3">Subject / Strategy</th>
                  <th className="px-4 py-3 text-right">Outreach Email</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-xs">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      Loading contacts...
                    </td>
                  </tr>
                ) : contactsList.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      No contacts found matching the selected filter.
                    </td>
                  </tr>
                ) : (
                  contactsList.map((contact) => (
                    <tr key={contact.id} className="hover:bg-muted/10 transition-colors">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-foreground">{contact.companyName}</p>
                        {contact.companyLocation && (
                          <p className="text-[11px] text-muted-foreground">{contact.companyLocation}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-foreground">{contact.contactName || '—'}</p>
                        {contact.designation && (
                          <p className="text-[11px] text-muted-foreground">{contact.designation}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-foreground">
                        {contact.email}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {contact.isRelevant === true ? (
                          <Badge variant="success">Relevant</Badge>
                        ) : contact.isRelevant === false ? (
                          <Badge variant="secondary">Filtered</Badge>
                        ) : (
                          <Badge variant="warning">Needs Review</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {contact.status === 'generated' && (
                          <Badge variant="success">Generated</Badge>
                        )}
                        {contact.status === 'queued' && (
                          <Badge variant="default">Queued</Badge>
                        )}
                        {contact.status === 'generating' && (
                          <Badge variant="warning">Generating</Badge>
                        )}
                        {contact.status === 'skipped' && (
                          <Badge variant="secondary">Skipped</Badge>
                        )}
                        {contact.status === 'failed' && (
                          <Badge variant="destructive">Failed</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        {contact.emailSubject ? (
                          <div>
                            <p className="font-medium text-foreground truncate">{contact.emailSubject}</p>
                            {contact.emailStrategy && (
                              <span className="text-[10px] text-muted-foreground font-mono">
                                strategy: {contact.emailStrategy}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            {contact.relevanceReason || (contact.isDuplicate ? 'Duplicate' : 'Not generated yet')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {contact.status === 'generated' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPreviewContact(contact)}
                            className="gap-1.5"
                          >
                            <Mail className="h-3.5 w-3.5 text-primary" />
                            Preview
                          </Button>
                        ) : contact.status === 'queued' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRegenerateSingle(contact.id)}
                            disabled={generatingContactId === contact.id}
                            className="gap-1 text-primary hover:text-primary"
                          >
                            {generatingContactId === contact.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Sparkles className="h-3.5 w-3.5" />
                            )}
                            Generate
                          </Button>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="pt-2 text-xs text-muted-foreground text-right">
            Showing {contactsList.length} of {totalCount} contacts
          </div>
        </CardContent>
      </Card>

      {/* Email Preview Modal */}
      {previewContact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="relative w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <Mail className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">
                    Personalized Outreach Email
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    To: {previewContact.contactName || previewContact.companyName} &lt;{previewContact.email}&gt;
                  </p>
                </div>
              </div>
              <button
                onClick={() => setPreviewContact(null)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Metadata tags */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {previewContact.emailStrategy && (
                  <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20">
                    Strategy: {previewContact.emailStrategy}
                  </Badge>
                )}
                {previewContact.resumeVersion && (
                  <span className="text-[11px] text-muted-foreground">
                    Resume version: {previewContact.resumeVersion.slice(0, 10)}
                  </span>
                )}
              </div>

              {/* Subject Line */}
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Subject Line</p>
                <p className="text-sm font-bold text-foreground">{previewContact.emailSubject}</p>
              </div>

              {/* Email Body Content */}
              <div className="rounded-lg border border-border p-4 bg-card font-sans text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                {previewContact.emailBody}
              </div>

              {/* Personalization Points if available */}
              {previewContact.personalizationPoints && (
                <div className="rounded-lg border border-border bg-muted/15 p-3 text-xs space-y-1.5">
                  <p className="font-semibold text-muted-foreground">Verified Personalization Anchors:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                    {(() => {
                      try {
                        const pts = JSON.parse(previewContact.personalizationPoints);
                        return Array.isArray(pts)
                          ? pts.map((p: string, i: number) => <li key={i}>{p}</li>)
                          : null;
                      } catch {
                        return null;
                      }
                    })()}
                  </ul>
                </div>
              )}

              {/* Send Safety Disclaimer */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Preview Only:</span> This email is stored safely in the database.
                  No emails will be sent until Gmail OAuth (Phase 4) and Scheduler (Phase 5) are authorized.
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between border-t border-border bg-muted/30 px-5 py-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRegenerateSingle(previewContact.id)}
                disabled={generatingContactId === previewContact.id}
                className="gap-1.5"
              >
                {generatingContactId === previewContact.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCw className="h-4 w-4" />
                )}
                Regenerate Email
              </Button>

              <Button variant="secondary" size="sm" onClick={() => setPreviewContact(null)}>
                Close Preview
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {batch && isDeleteModalOpen && (
        <DeleteBatchModal
          key={batch.id}
          batch={batch}
          isOpen={true}
          onClose={() => setIsDeleteModalOpen(false)}
          onSuccess={() => {
            setIsDeleteModalOpen(false);
            router.push('/batches');
          }}
        />
      )}
    </div>
  );
}
