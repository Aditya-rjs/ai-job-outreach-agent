'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  X,
  Search,
  RefreshCw,
  Building2,
  CheckCircle2,
  Inbox,
  Clock,
  Sparkles,
  Send,
  AlertCircle,
  Mail,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  ShieldCheck,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/utils';
import type { CompanyDetailRecord, QueuedContactDetailRecord } from '@/lib/dashboard-queries';
import type { Contact } from '@/types';

export type DashboardCardViewId =
  | 'total-companies'
  | 'relevant-tech'
  | 'contacts-found'
  | 'eligible-queued'
  | 'emails-generated'
  | 'emails-sent'
  | 'skipped-filtered';

interface DashboardDetailModalProps {
  view: DashboardCardViewId | null;
  onClose: () => void;
  isDryRun?: boolean;
}

export function DashboardDetailModal({
  view,
  onClose,
  isDryRun = false,
}: DashboardDetailModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // Data states
  const [companies, setCompanies] = useState<CompanyDetailRecord[]>([]);
  const [contacts, setContacts] = useState<(Contact & { batchFilename?: string; [key: string]: unknown })[]>([]);
  const [queuedContacts, setQueuedContacts] = useState<QueuedContactDetailRecord[]>([]);

  // Send mode for Emails Sent view ('real' | 'simulated')
  const [sentMode, setSentMode] = useState<'real' | 'simulated'>(isDryRun ? 'simulated' : 'real');

  // Full email preview reader state
  const [previewEmail, setPreviewEmail] = useState<{
    recipient: string;
    company: string;
    subject: string;
    body: string;
    strategy?: string;
    generatedAt?: string;
  } | null>(null);

  const PAGE_SIZE = 25;

  // Reset page and search on view switch
  useEffect(() => {
    setPage(1);
    setSearchQuery('');
    setSentMode(isDryRun ? 'simulated' : 'real');
    setPreviewEmail(null);
  }, [view, isDryRun]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (previewEmail) {
          setPreviewEmail(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, previewEmail]);

  // Fetch data
  const fetchData = useCallback(async () => {
    if (!view) return;
    setLoading(true);
    setError(null);

    try {
      if (view === 'total-companies' || view === 'relevant-tech') {
        const type = view === 'relevant-tech' ? 'relevant' : 'all';
        const params = new URLSearchParams({
          type,
          page: page.toString(),
          limit: PAGE_SIZE.toString(),
        });
        if (searchQuery) params.append('search', searchQuery);

        const res = await fetch(`/api/dashboard/companies?${params.toString()}`);
        const json = await res.json();
        if (json.success) {
          setCompanies(json.data.companies || []);
          setTotal(json.data.total || 0);
        } else {
          setError(json.error || 'Failed to fetch company details');
        }
      } else {
        const params = new URLSearchParams({
          view,
          page: page.toString(),
          limit: PAGE_SIZE.toString(),
        });
        if (searchQuery) params.append('search', searchQuery);
        if (view === 'emails-sent') params.append('mode', sentMode);

        const res = await fetch(`/api/contacts?${params.toString()}`);
        const json = await res.json();
        if (json.success) {
          if (view === 'eligible-queued') {
            setQueuedContacts(json.data.contacts || []);
          } else {
            setContacts(json.data.contacts || []);
          }
          setTotal(json.data.total || 0);
        } else {
          setError(json.error || 'Failed to fetch contact details');
        }
      }
    } catch (err: unknown) {
      console.error('Modal fetch error:', err);
      setError('An error occurred while loading data');
    } finally {
      setLoading(false);
    }
  }, [view, page, searchQuery, sentMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  if (!view) return null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Metadata per view
  const viewConfig: Record<
    DashboardCardViewId,
    { title: string; subtitle: string; icon: typeof Building2; color: string }
  > = {
    'total-companies': {
      title: 'Total Companies',
      subtitle: 'All distinct company entities identified across uploaded batches',
      icon: Building2,
      color: 'text-blue-600 bg-blue-50 border-blue-200',
    },
    'relevant-tech': {
      title: 'Relevant Tech Companies',
      subtitle: 'Companies confirmed as RELEVANT by Gemini for CS / IT / software outreach',
      icon: CheckCircle2,
      color: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    },
    'contacts-found': {
      title: 'Contacts Found',
      subtitle: 'Complete roster of all recipient contacts discovered across active batches',
      icon: Inbox,
      color: 'text-indigo-600 bg-indigo-50 border-indigo-200',
    },
    'eligible-queued': {
      title: 'Eligible Outreach Queue',
      subtitle: 'Active send candidates meeting all canonical eligibility and safety criteria',
      icon: Clock,
      color: 'text-amber-600 bg-amber-50 border-amber-200',
    },
    'emails-generated': {
      title: 'Generated AI Emails',
      subtitle: 'Personalized outreach emails successfully crafted by Gemini 3.8 Flash',
      icon: Sparkles,
      color: 'text-violet-600 bg-violet-50 border-violet-200',
    },
    'emails-sent': {
      title: sentMode === 'real' ? 'Real Gmail Outreach Sent' : 'Simulated Sends (Dry Run)',
      subtitle:
        sentMode === 'real'
          ? 'Authoritative successful Gmail sends verified in permanent global history'
          : 'Dry-run test outreach simulations (0 real emails sent)',
      icon: Send,
      color: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    },
    'skipped-filtered': {
      title: 'Skipped & Filtered Contacts',
      subtitle: 'Contacts excluded by system safety rules, invalid syntax, or Gemini irrelevance',
      icon: AlertCircle,
      color: 'text-red-600 bg-red-50 border-red-200',
    },
  };

  const currentConfig = viewConfig[view];
  const IconComponent = currentConfig.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-background/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="relative flex flex-col w-full max-w-6xl h-[92vh] max-h-[900px] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden focus:outline-none"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl border ${currentConfig.color}`}>
              <IconComponent className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-foreground">{currentConfig.title}</h2>
                <Badge variant="outline" className="font-mono text-xs font-semibold">
                  {total} records
                </Badge>
                <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full border border-border">
                  Single Source of Truth
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-1">{currentConfig.subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Toolbar & Search */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-3 border-b border-border/70 bg-secondary/30">
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={`Search ${currentConfig.title.toLowerCase()}...`}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              className="w-full pl-9 pr-4 py-1.5 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
            {/* Mode toggle for Emails Sent */}
            {view === 'emails-sent' && (
              <div className="flex items-center rounded-lg border border-border bg-background p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setSentMode('real');
                    setPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                    sentMode === 'real'
                      ? 'bg-primary text-primary-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Real Sends
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSentMode('simulated');
                    setPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                    sentMode === 'simulated'
                      ? 'bg-primary text-primary-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Simulated
                </button>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
              className="h-8 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
              <RefreshCw className="h-7 w-7 animate-spin text-primary" />
              <p className="text-xs">Loading verified records...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-64 gap-2 text-red-600">
              <AlertCircle className="h-8 w-8" />
              <p className="text-sm font-semibold">{error}</p>
              <Button size="sm" variant="outline" onClick={fetchData}>
                Try Again
              </Button>
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="rounded-full bg-muted p-4 mb-3">
                <IconComponent className="h-8 w-8 text-muted-foreground/60" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">No records found</h3>
              <p className="text-xs text-muted-foreground max-w-sm mt-1">
                {searchQuery
                  ? `No matches for "${searchQuery}". Try adjusting your search query.`
                  : `There are currently no records represented in the ${currentConfig.title} category.`}
              </p>
            </div>
          ) : (
            <>
              {/* VIEW 1 & 2: COMPANIES TABLE */}
              {(view === 'total-companies' || view === 'relevant-tech') && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-muted/50 text-muted-foreground border-b border-border font-medium">
                      <tr>
                        <th className="p-3">Company Name</th>
                        <th className="p-3">Gemini Classification</th>
                        <th className="p-3">Confidence</th>
                        <th className="p-3 text-center">Contacts</th>
                        <th className="p-3">Gemini Rationale</th>
                        <th className="p-3">Batch File</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {companies.map((c) => (
                        <tr key={c.normalizedName} className="hover:bg-muted/30 transition-colors">
                          <td className="p-3 font-semibold text-foreground">
                            {c.companyName}
                            {c.contactEmails.length > 0 && (
                              <p className="text-[11px] font-normal text-muted-foreground truncate max-w-xs mt-0.5">
                                {c.contactEmails.slice(0, 3).join(', ')}
                                {c.contactEmails.length > 3 && ` +${c.contactEmails.length - 3} more`}
                              </p>
                            )}
                          </td>
                          <td className="p-3">
                            <Badge
                              variant={
                                c.classificationResult === 'RELEVANT'
                                  ? 'success'
                                  : c.classificationResult === 'IRRELEVANT'
                                  ? 'destructive'
                                  : 'warning'
                              }
                            >
                              {c.classificationResult}
                            </Badge>
                          </td>
                          <td className="p-3 font-mono text-muted-foreground">
                            {c.confidence !== null ? `${Math.round(c.confidence * 100)}%` : '—'}
                          </td>
                          <td className="p-3 text-center font-bold text-foreground">
                            <span className="inline-block px-2 py-0.5 bg-secondary rounded-md">
                              {c.contactCount}
                            </span>
                          </td>
                          <td className="p-3 text-muted-foreground max-w-md line-clamp-2">
                            {c.reason || '—'}
                          </td>
                          <td className="p-3 text-muted-foreground">
                            {c.batchFilenames.join(', ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* VIEW 3: CONTACTS FOUND */}
              {view === 'contacts-found' && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-muted/50 text-muted-foreground border-b border-border font-medium">
                      <tr>
                        <th className="p-3">Contact</th>
                        <th className="p-3">Company & Title</th>
                        <th className="p-3">Contact Status</th>
                        <th className="p-3">Generation Status</th>
                        <th className="p-3">Duplicate?</th>
                        <th className="p-3">Batch</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {contacts.map((c) => (
                        <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                          <td className="p-3">
                            <p className="font-semibold text-foreground">{c.contactName || 'Recruiter / Hiring Lead'}</p>
                            <p className="font-mono text-muted-foreground text-[11px]">{c.email}</p>
                          </td>
                          <td className="p-3">
                            <p className="font-medium text-foreground">{c.companyName || '—'}</p>
                            <p className="text-muted-foreground text-[11px]">{c.designation || '—'}</p>
                          </td>
                          <td className="p-3">
                            <Badge variant={c.status === 'sent' ? 'success' : c.status === 'queued' ? 'default' : 'secondary'}>
                              {c.status}
                            </Badge>
                          </td>
                          <td className="p-3">
                            <Badge
                              variant={
                                c.generationStatus === 'GENERATED'
                                  ? 'success'
                                  : c.generationStatus === 'GENERATING'
                                  ? 'default'
                                  : c.generationStatus === 'RETRY_PENDING'
                                  ? 'warning'
                                  : c.generationStatus === 'GENERATION_FAILED'
                                  ? 'destructive'
                                  : 'secondary'
                              }
                            >
                              {c.generationStatus || 'None'}
                            </Badge>
                          </td>
                          <td className="p-3">
                            {c.isDuplicate ? (
                              <Badge variant="destructive">Duplicate</Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">Original</Badge>
                            )}
                          </td>
                          <td className="p-3 text-muted-foreground">{c.batchFilename || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* VIEW 4: ELIGIBLE QUEUED */}
              {view === 'eligible-queued' && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-muted/50 text-muted-foreground border-b border-border font-medium">
                      <tr>
                        <th className="p-3">Recipient</th>
                        <th className="p-3">Company</th>
                        <th className="p-3">Queue Status</th>
                        <th className="p-3">Sendability State</th>
                        <th className="p-3">Sendability Rationale</th>
                        <th className="p-3">Batch</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {queuedContacts.map((c) => (
                        <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                          <td className="p-3">
                            <p className="font-semibold text-foreground">{c.contactName || 'Recruiter'}</p>
                            <p className="font-mono text-muted-foreground text-[11px]">{c.email}</p>
                          </td>
                          <td className="p-3 font-medium text-foreground">{c.companyName || '—'}</td>
                          <td className="p-3">
                            <Badge variant={c.queueStatus === 'processing' ? 'default' : 'secondary'}>
                              {c.queueStatus}
                            </Badge>
                          </td>
                          <td className="p-3">
                            <Badge
                              variant={
                                c.sendabilityStatus === 'READY'
                                  ? 'success'
                                  : c.sendabilityStatus === 'GENERATING'
                                  ? 'default'
                                  : c.sendabilityStatus === 'RETRY_PENDING'
                                  ? 'warning'
                                  : 'secondary'
                              }
                            >
                              {c.sendabilityStatus}
                            </Badge>
                          </td>
                          <td className="p-3 text-muted-foreground max-w-sm">
                            {c.sendabilityReason}
                          </td>
                          <td className="p-3 text-muted-foreground">{c.batchFilename || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* VIEW 5: EMAILS GENERATED */}
              {view === 'emails-generated' && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-muted/50 text-muted-foreground border-b border-border font-medium">
                      <tr>
                        <th className="p-3">Recipient & Company</th>
                        <th className="p-3">Generated Subject</th>
                        <th className="p-3">Preview</th>
                        <th className="p-3">Strategy</th>
                        <th className="p-3">Status</th>
                        <th className="p-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {contacts.map((c) => (
                        <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                          <td className="p-3">
                            <p className="font-semibold text-foreground">{c.companyName || '—'}</p>
                            <p className="font-mono text-muted-foreground text-[11px]">{c.email}</p>
                          </td>
                          <td className="p-3 font-medium text-foreground max-w-xs truncate">
                            {c.emailSubject || '—'}
                          </td>
                          <td className="p-3 text-muted-foreground max-w-xs truncate">
                            {c.emailBody || '—'}
                          </td>
                          <td className="p-3">
                            <span className="text-[11px] text-muted-foreground bg-secondary px-2 py-0.5 rounded border border-border">
                              {c.emailStrategy || 'direct'}
                            </span>
                          </td>
                          <td className="p-3">
                            <Badge variant="success">GENERATED</Badge>
                          </td>
                          <td className="p-3 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setPreviewEmail({
                                  recipient: c.email,
                                  company: c.companyName || '',
                                  subject: c.emailSubject || '',
                                  body: c.emailBody || '',
                                  strategy: c.emailStrategy || 'direct',
                                  generatedAt: c.updatedAt,
                                })
                              }
                              className="h-7 text-xs gap-1.5"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              Read Email
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* VIEW 6: EMAILS SENT */}
              {view === 'emails-sent' && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-muted/50 text-muted-foreground border-b border-border font-medium">
                      <tr>
                        <th className="p-3">Recipient & Company</th>
                        <th className="p-3">Subject</th>
                        <th className="p-3">Sent Timestamp</th>
                        <th className="p-3">Gmail Message ID</th>
                        <th className="p-3">Send Type</th>
                        <th className="p-3">Batch</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {contacts.map((c) => (
                        <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                          <td className="p-3">
                            <p className="font-semibold text-foreground">{c.contactName || c.companyName}</p>
                            <p className="font-mono text-muted-foreground text-[11px]">{c.email}</p>
                          </td>
                          <td className="p-3 font-medium text-foreground max-w-xs truncate">
                            {c.emailSubject || '—'}
                          </td>
                          <td className="p-3 text-muted-foreground">
                            {c.sentAt ? formatDateTime(c.sentAt) : '—'}
                          </td>
                          <td className="p-3">
                            {c.gmailMessageId ? (
                              <code className="px-1.5 py-0.5 bg-secondary rounded text-[11px] font-mono text-foreground border border-border">
                                {c.gmailMessageId}
                              </code>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="p-3">
                            {sentMode === 'real' ? (
                              <Badge variant="success" className="gap-1">
                                <ShieldCheck className="h-3 w-3" /> Real Gmail Send
                              </Badge>
                            ) : (
                              <Badge variant="secondary">Simulated (Dry Run)</Badge>
                            )}
                          </td>
                          <td className="p-3 text-muted-foreground">{c.batchFilename || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* VIEW 7: SKIPPED / FILTERED */}
              {view === 'skipped-filtered' && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-muted/50 text-muted-foreground border-b border-border font-medium">
                      <tr>
                        <th className="p-3">Contact</th>
                        <th className="p-3">Company</th>
                        <th className="p-3">Final Status</th>
                        <th className="p-3">Exact System Reason</th>
                        <th className="p-3">Batch File</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {contacts.map((c) => (
                        <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                          <td className="p-3">
                            <p className="font-semibold text-foreground">{c.contactName || 'Contact'}</p>
                            <p className="font-mono text-muted-foreground text-[11px]">{c.email}</p>
                          </td>
                          <td className="p-3 font-medium text-foreground">{c.companyName || '—'}</td>
                          <td className="p-3">
                            <Badge variant="destructive">SKIPPED</Badge>
                          </td>
                          <td className="p-3 text-muted-foreground max-w-md">
                            <span className="inline-flex items-center gap-1.5 font-medium text-foreground/90">
                              <Info className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                              {c.relevanceReason || c.errorMessage || 'Filtered out by outreach safety rules'}
                            </span>
                          </td>
                          <td className="p-3 text-muted-foreground">{c.batchFilename || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer & Pagination */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-card text-xs text-muted-foreground">
          <div>
            Showing <span className="font-medium text-foreground">{total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}</span> to{' '}
            <span className="font-medium text-foreground">{Math.min(page * PAGE_SIZE, total)}</span> of{' '}
            <span className="font-medium text-foreground">{total}</span> records
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="h-8 px-2.5 text-xs"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </Button>
            <span className="text-xs font-medium px-2 text-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="h-8 px-2.5 text-xs"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* READ-ONLY EMAIL PREVIEW DIALOG */}
      {previewEmail && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-background/90 backdrop-blur-sm animate-in fade-in duration-100">
          <div className="flex flex-col w-full max-w-2xl max-h-[85vh] bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-secondary/40">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">Generated Email Preview (Read-Only)</h3>
              </div>
              <button
                onClick={() => setPreviewEmail(null)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 overflow-auto space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-2 p-3 bg-secondary/30 rounded-lg border border-border/60">
                <div>
                  <p className="text-muted-foreground text-[10px]">RECIPIENT</p>
                  <p className="font-mono font-medium text-foreground">{previewEmail.recipient}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">COMPANY</p>
                  <p className="font-medium text-foreground">{previewEmail.company}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">STRATEGY</p>
                  <p className="font-medium text-foreground">{previewEmail.strategy}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">GENERATED AT</p>
                  <p className="font-medium text-foreground">
                    {previewEmail.generatedAt ? formatDateTime(previewEmail.generatedAt) : '—'}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-muted-foreground text-[10px] uppercase font-semibold mb-1">Subject</p>
                <div className="p-2.5 bg-background rounded-lg border border-border font-medium text-foreground">
                  {previewEmail.subject}
                </div>
              </div>

              <div>
                <p className="text-muted-foreground text-[10px] uppercase font-semibold mb-1">Body</p>
                <div className="p-3.5 bg-background rounded-lg border border-border whitespace-pre-wrap font-sans text-foreground leading-relaxed">
                  {previewEmail.body}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-secondary/20 text-[11px] text-muted-foreground">
              <span>Read-only preview. Opening this view never triggers email generation or sending.</span>
              <Button size="sm" variant="outline" onClick={() => setPreviewEmail(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
