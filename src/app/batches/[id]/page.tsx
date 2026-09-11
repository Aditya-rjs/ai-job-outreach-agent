'use client';

import React, { useState, useEffect, useCallback, use } from 'react';
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
  AlertTriangle,
  X,
  Trash2,
  Building2,
  Layers,
  User,
  Send,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Clock,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn, formatDateTime } from '@/lib/utils';
import { DeleteBatchModal } from '@/components/batches/delete-batch-modal';
import type { Batch } from '@/types';
import type {
  ProcessingPipelineStats,
  ClassificationPendingRecord,
  CompanyContactItem,
  GenerationPendingRecord,
  GenerationRetryRecord,
  GenerationFailedRecord,
  ReadyToSendRecord,
  CompanyFoundRecord,
  DuplicateCompanyRecord,
  AiProcessedRecord,
  IrrelevantCompanyRecord,
  CsItRelevantRecord,
  ContactFoundRecord,
  DuplicateContactRecord,
} from '@/lib/processing-queries';

export type ProcessingMetricCategory =
  | 'companies-found'
  | 'duplicate-companies'
  | 'classification-pending'
  | 'classification-retry-waiting'
  | 'ai-processed'
  | 'irrelevant-companies'
  | 'cs-it-relevant'
  | 'contacts-found'
  | 'duplicate-contacts'
  | 'generation-pending'
  | 'generation-retry'
  | 'generation-failed'
  | 'ready-to-send';

interface MetricMeta {
  key: ProcessingMetricCategory;
  label: string;
  countKey: keyof ProcessingPipelineStats;
  icon: React.ElementType;
  description: string;
  badge?: (stats: ProcessingPipelineStats) => { label: string; className: string } | null;
}

export default function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const resolvedParams = use(params);
  const batchId = resolvedParams.id;

  // Batch header metadata
  const [batch, setBatch] = useState<Batch | null>(null);
  const [loadingBatch, setLoadingBatch] = useState(true);

  // 13 Processing Stats for this batch
  const [stats, setStats] = useState<ProcessingPipelineStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Active Clicked Metric Detail State
  const [activeCategory, setActiveCategory] = useState<ProcessingMetricCategory | null>('companies-found');
  const [detailRecords, setDetailRecords] = useState<unknown[]>([]);
  const [detailTotal, setDetailTotal] = useState(0);
  const [detailPage, setDetailPage] = useState(1);
  const [detailTotalPages, setDetailTotalPages] = useState(1);
  const [detailSearch, setDetailSearch] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Company Contacts Expansion State
  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>({});
  const [companyContacts, setCompanyContacts] = useState<Record<string, CompanyContactItem[]>>({});
  const [loadingCompanyContacts, setLoadingCompanyContacts] = useState<Record<string, boolean>>({});

  // Modals
  const [previewEmail, setPreviewEmail] = useState<ReadyToSendRecord | null>(null);
  const [inspectFailure, setInspectFailure] = useState<GenerationFailedRecord | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  // Batch Actions
  const [isGeneratingBatch, setIsGeneratingBatch] = useState(false);
  const [generationFeedback, setGenerationFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // 1. Fetch Batch Header Info
  const fetchBatchHeader = useCallback(async () => {
    try {
      const res = await fetch(`/api/batches/${batchId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load batch');
      const json = await res.json();
      if (json.success && json.data) {
        setBatch(json.data);
      }
    } catch (err) {
      console.error('Failed to load batch header:', err);
    } finally {
      setLoadingBatch(false);
    }
  }, [batchId]);

  // 2. Fetch Batch-Scoped 13 Metrics & Active Detail
  const fetchProcessingData = useCallback(
    async (isManual = false, targetCategory = activeCategory, targetPage = detailPage, targetSearch = detailSearch) => {
      if (isManual) setIsRefreshing(true);
      if (targetCategory) setLoadingDetail(true);

      try {
        const queryParams = new URLSearchParams({
          batchId,
          limit: '20',
          page: String(targetPage),
          search: targetSearch.trim(),
          _t: String(Date.now()),
        });
        if (targetCategory) {
          queryParams.set('category', targetCategory);
        }

        const res = await fetch(`/api/dashboard/processing?${queryParams.toString()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        });

        if (!res.ok) throw new Error('Failed to fetch processing data');
        const json = await res.json();

        if (json.success && json.data) {
          setStats(json.data.stats);
          setLastUpdated(new Date(json.data.lastUpdated));

          if (targetCategory) {
            setDetailRecords(json.data.records || []);
            setDetailTotal(json.data.total || 0);
            setDetailTotalPages(json.data.totalPages || 1);
          }
        }
      } catch (err) {
        console.error('Error fetching batch processing data:', err);
      } finally {
        setLoadingStats(false);
        setLoadingDetail(false);
        setIsRefreshing(false);
      }
    },
    [batchId, activeCategory, detailPage, detailSearch]
  );

  // Initial Load
  useEffect(() => {
    fetchBatchHeader();
    fetchProcessingData(false, activeCategory, 1, '');
  }, [fetchBatchHeader, fetchProcessingData, activeCategory]);

  // Periodic Polling (Every 5s while processing/queued)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchProcessingData(false, activeCategory, detailPage, detailSearch);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchProcessingData, activeCategory, detailPage, detailSearch]);

  // Fetch Company Contacts on Expand
  const toggleCompanyContacts = async (normalizedName: string) => {
    const isCurrentlyExpanded = !!expandedCompanies[normalizedName];
    setExpandedCompanies((prev) => ({ ...prev, [normalizedName]: !isCurrentlyExpanded }));

    if (!isCurrentlyExpanded && !companyContacts[normalizedName]) {
      setLoadingCompanyContacts((prev) => ({ ...prev, [normalizedName]: true }));
      try {
        const res = await fetch(
          `/api/dashboard/processing?batchId=${batchId}&companyContacts=${encodeURIComponent(normalizedName)}&_t=${Date.now()}`,
          { cache: 'no-store' }
        );
        const json = await res.json();
        if (json.success && json.data?.contacts) {
          setCompanyContacts((prev) => ({ ...prev, [normalizedName]: json.data.contacts }));
        }
      } catch (err) {
        console.error('Failed to load company contacts:', err);
      } finally {
        setLoadingCompanyContacts((prev) => ({ ...prev, [normalizedName]: false }));
      }
    }
  };

  // Handle Card Click (Toggle or Switch Active Metric)
  const handleCardClick = (categoryKey: ProcessingMetricCategory) => {
    if (activeCategory === categoryKey) {
      // Toggle off if already open
      setActiveCategory(null);
    } else {
      setActiveCategory(categoryKey);
      setDetailPage(1);
      setDetailSearch('');
      fetchProcessingData(false, categoryKey, 1, '');
    }
  };

  // Trigger Immediate Batch Email Generation
  const handleGenerateBatch = async () => {
    setIsGeneratingBatch(true);
    setGenerationFeedback(null);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, forceRegenerate: false }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to generate emails.');
      }

      setGenerationFeedback({
        type: 'success',
        message: `Successfully generated ${json.data.generatedCount} personalized email(s).`,
      });
      fetchBatchHeader();
      fetchProcessingData(true, activeCategory, detailPage, detailSearch);
    } catch (err: unknown) {
      setGenerationFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Error generating emails.',
      });
    } finally {
      setIsGeneratingBatch(false);
    }
  };

  // 13 Metric Card Configurations in 3 Rows
  const row1Metrics: MetricMeta[] = [
    {
      key: 'companies-found',
      label: 'Companies Found',
      countKey: 'companiesFound',
      icon: Building2,
      description: 'Unique companies in batch',
    },
    {
      key: 'duplicate-companies',
      label: 'Duplicate Companies',
      countKey: 'duplicateCompanies',
      icon: Layers,
      description: 'Companies with multiple contacts',
    },
    {
      key: 'classification-pending',
      label: 'AI Search Pending',
      countKey: 'aiSearchPending',
      icon: Search,
      description: 'Awaiting AI classification',
      badge: (s) =>
        s.aiSearchPending > 0
          ? { label: 'Active', className: 'bg-amber-100 text-amber-800 border-amber-300' }
          : null,
    },
    {
      key: 'classification-retry-waiting',
      label: 'AI Search Retry',
      countKey: 'aiSearchRetry',
      icon: RefreshCw,
      description: 'Unresolved in current round',
      badge: (s) =>
        s.aiSearchRetry > 0
          ? { label: 'Waiting', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' }
          : null,
    },
    {
      key: 'ai-processed',
      label: 'AI Processed',
      countKey: 'aiProcessed',
      icon: CheckCircle2,
      description: 'Terminal classification reached',
    },
  ];

  const row2Metrics: MetricMeta[] = [
    {
      key: 'irrelevant-companies',
      label: 'Irrelevant Companies',
      countKey: 'irrelevantCompanies',
      icon: AlertTriangle,
      description: 'Outside outreach scope',
    },
    {
      key: 'cs-it-relevant',
      label: 'CS/IT Relevant',
      countKey: 'csItRelevant',
      icon: CheckCircle2,
      description: 'Confirmed CS/IT companies',
    },
    {
      key: 'contacts-found',
      label: 'Contacts Found',
      countKey: 'contactsFound',
      icon: User,
      description: 'Total contacts imported',
    },
    {
      key: 'duplicate-contacts',
      label: 'Duplicate Contacts',
      countKey: 'duplicateContacts',
      icon: Layers,
      description: 'Duplicate email contacts',
    },
    {
      key: 'generation-pending',
      label: 'Emails Generating',
      countKey: 'emailsGenerating',
      icon: Sparkles,
      description: (stats && (stats.aiSearchPending > 0 || stats.aiSearchRetry > 0))
        ? 'Classification incomplete'
        : (stats?.emailsGenerating ?? 0) > 0
          ? 'Generating emails'
          : 'All emails generated',
      badge: (s) => {
        if (s.aiSearchPending > 0 || s.aiSearchRetry > 0) {
          return { label: 'Blocked', className: 'bg-amber-100 text-amber-800 border-amber-300' };
        }
        if (s.emailsGenerating > 0) {
          return { label: 'Active', className: 'bg-blue-100 text-blue-800 border-blue-300' };
        }
        return { label: 'Idle', className: 'bg-muted text-muted-foreground border-border' };
      },
    },
  ];

  const row3Metrics: MetricMeta[] = [
    {
      key: 'generation-retry',
      label: 'Generation Retry',
      countKey: 'generationRetry',
      icon: RefreshCw,
      description: (stats && (stats.aiSearchPending > 0 || stats.aiSearchRetry > 0))
        ? 'Classification incomplete'
        : (stats?.emailsGenerating ?? 0) > 0 && (stats?.generationRetry ?? 0) > 0
          ? 'Waiting for active pass'
          : (stats?.generationRetry ?? 0) > 0
            ? 'Generation retries eligible'
            : 'No retries pending',
      badge: (s) => {
        if (s.aiSearchPending > 0 || s.aiSearchRetry > 0) {
          return { label: 'Blocked', className: 'bg-amber-100 text-amber-800 border-amber-300' };
        }
        if (s.emailsGenerating > 0 && s.generationRetry > 0) {
          return { label: 'Waiting', className: 'bg-amber-100 text-amber-800 border-amber-300' };
        }
        if (s.generationRetry > 0) {
          return { label: 'Eligible', className: 'bg-orange-100 text-orange-800 border-orange-300' };
        }
        return { label: 'Idle', className: 'bg-muted text-muted-foreground border-border' };
      },
    },
    {
      key: 'generation-failed',
      label: 'Generation Failed',
      countKey: 'generationFailed',
      icon: AlertTriangle,
      description: (stats && (stats.aiSearchPending > 0 || stats.aiSearchRetry > 0))
        ? 'Classification incomplete'
        : 'Permanent generation failure',
      badge: (s) => {
        if (s.aiSearchPending > 0 || s.aiSearchRetry > 0) {
          return { label: 'Blocked', className: 'bg-amber-100 text-amber-800 border-amber-300' };
        }
        if (s.generationFailed > 0) {
          return { label: 'Terminal', className: 'bg-red-100 text-red-800 border-red-300' };
        }
        return { label: 'None', className: 'bg-muted text-muted-foreground border-border' };
      },
    },
    {
      key: 'ready-to-send',
      label: 'Ready to Send',
      countKey: 'readyToSend',
      icon: Send,
      description: 'Personalized emails staged',
      badge: () => ({ label: 'Staged', className: 'bg-emerald-100 text-emerald-800 border-emerald-300' }),
    },
  ];

  // Helper to render a metric card
  const renderMetricCard = (meta: MetricMeta) => {
    const Icon = meta.icon;
    const value = stats ? (stats[meta.countKey] as number) ?? 0 : 0;
    const isActive = activeCategory === meta.key;
    const badgeInfo = stats && meta.badge ? meta.badge(stats) : null;

    return (
      <div
        key={meta.key}
        onClick={() => handleCardClick(meta.key)}
        className={cn(
          'rounded-xl border p-3.5 shadow-sm flex flex-col justify-between min-h-[110px] min-w-0 cursor-pointer transition-all select-none',
          isActive
            ? 'border-primary ring-2 ring-primary/40 bg-primary/5 shadow-md'
            : 'border-border bg-card hover:border-border/80 hover:bg-muted/40'
        )}
      >
        <div className="flex items-start justify-between gap-1.5">
          <div className="space-y-1 min-w-0">
            <span
              className={cn(
                'text-xs font-semibold flex items-center gap-1.5 truncate',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <Icon className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-primary' : 'text-slate-500')} />
              {meta.label}
            </span>
            <p className="text-2xl font-bold text-foreground">{value}</p>
          </div>
          {badgeInfo && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-bold border shrink-0',
                badgeInfo.className
              )}
            >
              {badgeInfo.label}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-[11px] text-muted-foreground leading-tight truncate">{meta.description}</p>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
              isActive && 'rotate-180 text-primary'
            )}
          />
        </div>
      </div>
    );
  };

  const activeMeta = [...row1Metrics, ...row2Metrics, ...row3Metrics].find((m) => m.key === activeCategory);

  return (
    <div className="space-y-6">
      {/* ── BATCH HEADER ── */}
      <div className="flex items-center gap-3">
        <Link href="/batches">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Back to Batches
          </Button>
        </Link>
      </div>

      {batch && (
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">{batch.filename}</h2>
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
                fetchBatchHeader();
                fetchProcessingData(true, activeCategory, detailPage, detailSearch);
              }}
              disabled={isRefreshing || loadingStats}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', (isRefreshing || loadingStats) && 'animate-spin')} />
              Refresh
            </Button>

            <Button
              size="sm"
              onClick={handleGenerateBatch}
              disabled={isGeneratingBatch || loadingStats}
              className="gap-1.5 text-xs"
            >
              {isGeneratingBatch ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate Now
                </>
              )}
            </Button>

            <Button
              variant="destructive"
              size="sm"
              onClick={() => setIsDeleteModalOpen(true)}
              disabled={loadingStats || isGeneratingBatch}
              className="gap-1.5 text-xs bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 border border-red-200"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Batch
            </Button>
          </div>
        </div>
      )}

      {/* Feedback Banner */}
      {generationFeedback && (
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border p-3.5 text-xs',
            generationFeedback.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          )}
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

      {/* ── 13 CANONICAL PROCESSING METRICS (Batch-Scoped) ── */}
      <section className="space-y-3 pt-2">
        <div className="flex items-center justify-between border-b border-border/70 pb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-foreground">
              Batch Processing Metrics
            </h3>
            <span className="text-xs text-muted-foreground">
              (Click any metric to view its batch-scoped records)
            </span>
          </div>
          {lastUpdated && (
            <span className="font-mono text-[11px] text-muted-foreground">
              Updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* Row 1 (5 cards) */}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {row1Metrics.map(renderMetricCard)}
        </div>

        {/* Row 2 (5 cards) */}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {row2Metrics.map(renderMetricCard)}
        </div>

        {/* Row 3 (3 cards) */}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 lg:grid-cols-3">
          {row3Metrics.map(renderMetricCard)}
        </div>
      </section>

      {/* ── EXPANDABLE CLICKED METRIC DETAIL VIEW ── */}
      {activeCategory && activeMeta && (
        <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden animate-in fade-in-50 duration-200">
          {/* Detail Section Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border-b border-border bg-muted/20">
            <div className="flex items-center gap-2.5">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <activeMeta.icon className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-base font-bold text-foreground">{activeMeta.label}</h4>
                  <Badge variant="outline" className="font-mono text-xs">
                    {detailTotal} {detailTotal === 1 ? 'record' : 'records'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Search Bar */}
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={detailSearch}
                  onChange={(e) => {
                    setDetailSearch(e.target.value);
                    setDetailPage(1);
                    fetchProcessingData(false, activeCategory, 1, e.target.value);
                  }}
                  placeholder="Search in this metric..."
                  className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              {/* Close Detail Button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveCategory(null)}
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
                title="Collapse detail view"
              >
                <X className="h-4 w-4 mr-1" />
                Close
              </Button>
            </div>
          </div>

          {/* Classification Barrier Notice for Emails Generating */}
          {activeCategory === 'generation-pending' &&
            stats &&
            (stats.aiSearchPending > 0 || stats.aiSearchRetry > 0) && (
              <div className="p-4 m-4 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                  Email Generation Gated by Classification Barrier
                </div>
                <p>
                  Company classification is currently in progress for this batch. All email generation is strictly
                  gated until <strong>AI Search Pending</strong> (currently {stats.aiSearchPending}) and{' '}
                  <strong>AI Search Retry</strong> (currently {stats.aiSearchRetry}) reach 0.
                </p>
              </div>
            )}

          {/* Detail Body Content */}
          <div className="p-4">
            {loadingDetail ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground text-xs gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Loading {activeMeta.label.toLowerCase()} for this batch...
              </div>
            ) : detailRecords.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground space-y-1">
                <p className="text-sm font-semibold text-foreground">No records found</p>
                <p className="text-xs max-w-sm">
                  {detailSearch
                    ? `No matching records for "${detailSearch}" in this batch.`
                    : `Zero records present for ${activeMeta.label.toLowerCase()} in this batch.`}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                {/* 1. Companies Found Table */}
                {activeCategory === 'companies-found' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Company Name</th>
                        <th className="px-3 py-2.5">Normalized Entity</th>
                        <th className="px-3 py-2.5">Contacts in Batch</th>
                        <th className="px-3 py-2.5">Classification</th>
                        <th className="px-3 py-2.5">Confidence & Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as CompanyFoundRecord[]).map((rec) => {
                        const isExpanded = !!expandedCompanies[rec.normalizedName];
                        const contacts = companyContacts[rec.normalizedName] || [];
                        const isLoadingContacts = !!loadingCompanyContacts[rec.normalizedName];

                        return (
                          <React.Fragment key={rec.companyName}>
                            <tr className="hover:bg-muted/20 transition-colors">
                              <td className="px-3 py-2.5 font-medium text-foreground">{rec.companyName}</td>
                              <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                                {rec.normalizedName}
                              </td>
                              <td className="px-3 py-2.5">
                                <button
                                  onClick={() => toggleCompanyContacts(rec.normalizedName)}
                                  className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
                                >
                                  {rec.contactCount} contact(s)
                                  <ChevronRight
                                    className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
                                  />
                                </button>
                              </td>
                              <td className="px-3 py-2.5">
                                <Badge
                                  variant={
                                    rec.classificationResult === 'RELEVANT'
                                      ? 'success'
                                      : rec.classificationResult === 'IRRELEVANT'
                                        ? 'destructive'
                                        : 'outline'
                                  }
                                  className="text-[10px]"
                                >
                                  {rec.classificationResult}
                                </Badge>
                              </td>
                              <td className="px-3 py-2.5 max-w-xs truncate text-muted-foreground" title={rec.reason || ''}>
                                {rec.reason || 'Pending evaluation'}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr>
                                <td colSpan={5} className="px-4 py-3 bg-muted/30">
                                  {isLoadingContacts ? (
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                      Loading contacts for {rec.companyName}...
                                    </div>
                                  ) : contacts.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                      {rec.contactEmails.length > 0
                                        ? `Contacts: ${rec.contactEmails.join(', ')}`
                                        : 'No contact records recorded.'}
                                    </p>
                                  ) : (
                                    <div className="space-y-1.5">
                                      <p className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
                                        Contacts in this batch ({contacts.length}):
                                      </p>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                        {contacts.map((c) => (
                                          <div
                                            key={c.id}
                                            className="rounded border border-border bg-card p-2 text-xs flex flex-col"
                                          >
                                            <span className="font-semibold text-foreground">
                                              {c.contactName || 'Unnamed Contact'}
                                            </span>
                                            <span className="text-muted-foreground font-mono text-[11px]">
                                              {c.email}
                                            </span>
                                            {c.designation && (
                                              <span className="text-[11px] text-muted-foreground mt-0.5">
                                                {c.designation}
                                              </span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* 2. Duplicate Companies Table */}
                {activeCategory === 'duplicate-companies' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Company Name</th>
                        <th className="px-3 py-2.5">Normalized Entity</th>
                        <th className="px-3 py-2.5">Contacts in Batch</th>
                        <th className="px-3 py-2.5">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as DuplicateCompanyRecord[]).map((rec) => {
                        const isExpanded = !!expandedCompanies[rec.normalizedName];
                        const contacts = companyContacts[rec.normalizedName] || [];
                        const isLoadingContacts = !!loadingCompanyContacts[rec.normalizedName];

                        return (
                          <React.Fragment key={rec.normalizedName}>
                            <tr className="hover:bg-muted/20 transition-colors">
                              <td className="px-3 py-2.5 font-bold text-foreground">
                                {rec.companyName || rec.normalizedName}
                              </td>
                              <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                                {rec.normalizedName}
                              </td>
                              <td className="px-3 py-2.5">
                                <button
                                  onClick={() => toggleCompanyContacts(rec.normalizedName)}
                                  className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline cursor-pointer"
                                >
                                  {rec.contactCount} contact(s)
                                  <ChevronRight
                                    className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
                                  />
                                </button>
                              </td>
                              <td className="px-3 py-2.5 text-muted-foreground">{rec.explanation}</td>
                            </tr>
                            {isExpanded && (
                              <tr>
                                <td colSpan={4} className="px-4 py-3 bg-muted/30">
                                  {isLoadingContacts ? (
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                      Loading contacts for {rec.companyName || rec.normalizedName}...
                                    </div>
                                  ) : contacts.length === 0 ? (
                                    <div className="space-y-1 text-xs text-muted-foreground">
                                      {rec.representativeContacts && rec.representativeContacts.length > 0 ? (
                                        rec.representativeContacts.map((rep, idx) => (
                                          <div key={idx} className="font-mono text-[11px]">
                                            {rep}
                                          </div>
                                        ))
                                      ) : (
                                        <p>No contact details recorded.</p>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="space-y-1.5">
                                      <p className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
                                        Contacts in this batch ({contacts.length}):
                                      </p>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                        {contacts.map((c) => (
                                          <div
                                            key={c.id}
                                            className="rounded border border-border bg-card p-2 text-xs flex flex-col"
                                          >
                                            <span className="font-semibold text-foreground">
                                              {c.contactName || 'Unnamed Contact'}
                                            </span>
                                            <span className="text-muted-foreground font-mono text-[11px]">
                                              {c.email}
                                            </span>
                                            {c.designation && (
                                              <span className="text-[11px] text-muted-foreground mt-0.5">
                                                {c.designation}
                                              </span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* 3. AI Search Pending Table */}
                {activeCategory === 'classification-pending' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Company Name</th>
                        <th className="px-3 py-2.5">Contacts</th>
                        <th className="px-3 py-2.5">Round / Attempts</th>
                        <th className="px-3 py-2.5">Model</th>
                        <th className="px-3 py-2.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as ClassificationPendingRecord[]).map((rec) => (
                        <tr key={rec.normalizedName} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.companyName}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.contactCount} contact(s)</td>
                          <td className="px-3 py-2.5">
                            Round {rec.retryRound} (Attempt {rec.retryCount})
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                            {rec.geminiModel}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge variant="warning" className="text-[10px]">
                              PENDING
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 4. AI Search Retry Table */}
                {activeCategory === 'classification-retry-waiting' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Company Name</th>
                        <th className="px-3 py-2.5">Contacts</th>
                        <th className="px-3 py-2.5">Round / Attempts</th>
                        <th className="px-3 py-2.5">Last Error</th>
                        <th className="px-3 py-2.5">Next Retry</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as ClassificationPendingRecord[]).map((rec) => (
                        <tr key={rec.normalizedName} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.companyName}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.contactCount} contact(s)</td>
                          <td className="px-3 py-2.5">
                            Round {rec.retryRound} (Attempt {rec.retryCount})
                          </td>
                          <td className="px-3 py-2.5 text-red-600 font-mono text-[11px]">
                            {rec.lastErrorCategory || 'rate_limit'}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground font-mono text-[11px]">
                            {rec.nextRetryAt ? formatDateTime(rec.nextRetryAt) : 'Pending'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 5. AI Processed Table */}
                {activeCategory === 'ai-processed' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Company Name</th>
                        <th className="px-3 py-2.5">Contacts</th>
                        <th className="px-3 py-2.5">Result</th>
                        <th className="px-3 py-2.5">Confidence</th>
                        <th className="px-3 py-2.5">Reason</th>
                        <th className="px-3 py-2.5">Source / Model</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as AiProcessedRecord[]).map((rec) => (
                        <tr key={rec.normalizedName} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.companyName}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.contactCount} contact(s)</td>
                          <td className="px-3 py-2.5">
                            <Badge
                              variant={
                                rec.classificationResult === 'RELEVANT'
                                  ? 'success'
                                  : rec.classificationResult === 'IRRELEVANT'
                                    ? 'destructive'
                                    : 'warning'
                              }
                              className="text-[10px]"
                            >
                              {rec.classificationResult}
                            </Badge>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-muted-foreground">
                            {rec.confidence ? `${Math.round(rec.confidence * 100)}%` : '—'}
                          </td>
                          <td className="px-3 py-2.5 max-w-sm truncate text-muted-foreground" title={rec.reason || ''}>
                            {rec.reason || '—'}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                            {rec.geminiModel || rec.source}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 6. Irrelevant Companies Table */}
                {activeCategory === 'irrelevant-companies' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Company Name</th>
                        <th className="px-3 py-2.5">Contacts Filtered</th>
                        <th className="px-3 py-2.5">Relevance Confidence</th>
                        <th className="px-3 py-2.5">Irrelevance Reason</th>
                        <th className="px-3 py-2.5">Classifier Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as IrrelevantCompanyRecord[]).map((rec) => (
                        <tr key={rec.normalizedName} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.companyName}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.contactCount} contact(s)</td>
                          <td className="px-3 py-2.5 font-mono text-muted-foreground">
                            {rec.confidence ? `${Math.round(rec.confidence * 100)}%` : '—'}
                          </td>
                          <td className="px-3 py-2.5 max-w-md truncate text-muted-foreground" title={rec.reason || ''}>
                            {rec.reason || 'Outside CS/IT scope'}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                            {rec.geminiModel || rec.source}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 7. CS/IT Relevant Table */}
                {activeCategory === 'cs-it-relevant' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Company Name</th>
                        <th className="px-3 py-2.5">Eligible Contacts</th>
                        <th className="px-3 py-2.5">Relevance Confidence</th>
                        <th className="px-3 py-2.5">Evaluation Reason</th>
                        <th className="px-3 py-2.5">Source / Authority</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as CsItRelevantRecord[]).map((rec) => (
                        <tr key={rec.normalizedName} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.companyName}</td>
                          <td className="px-3 py-2.5 font-semibold text-emerald-600">{rec.contactCount} contact(s)</td>
                          <td className="px-3 py-2.5 font-mono text-muted-foreground">
                            {rec.confidence ? `${Math.round(rec.confidence * 100)}%` : '100%'}
                          </td>
                          <td className="px-3 py-2.5 max-w-md truncate text-muted-foreground" title={rec.reason || ''}>
                            {rec.reason || 'Confirmed CS/IT relevance'}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                            {rec.geminiModel || rec.source}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 8. Contacts Found Table */}
                {activeCategory === 'contacts-found' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Contact Name</th>
                        <th className="px-3 py-2.5">Email</th>
                        <th className="px-3 py-2.5">Company</th>
                        <th className="px-3 py-2.5">Designation</th>
                        <th className="px-3 py-2.5">Relevance</th>
                        <th className="px-3 py-2.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as ContactFoundRecord[]).map((rec) => (
                        <tr key={rec.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.contactName || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{rec.email}</td>
                          <td className="px-3 py-2.5 text-foreground">{rec.companyName || '—'}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.designation || '—'}</td>
                          <td className="px-3 py-2.5">
                            {rec.isRelevant === true ? (
                              <Badge variant="success" className="text-[10px]">
                                Relevant
                              </Badge>
                            ) : rec.isRelevant === false ? (
                              <Badge variant="destructive" className="text-[10px]">
                                Filtered
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px]">
                                Pending
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge variant="secondary" className="text-[10px]">
                              {rec.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 9. Duplicate Contacts Table */}
                {activeCategory === 'duplicate-contacts' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Contact Name</th>
                        <th className="px-3 py-2.5">Duplicate Email</th>
                        <th className="px-3 py-2.5">Company</th>
                        <th className="px-3 py-2.5">Duplicate Reason</th>
                        <th className="px-3 py-2.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as DuplicateContactRecord[]).map((rec) => (
                        <tr key={rec.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.contactName || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-amber-700">{rec.email}</td>
                          <td className="px-3 py-2.5 text-foreground">{rec.companyName || '—'}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.duplicateReason}</td>
                          <td className="px-3 py-2.5">
                            <Badge variant="warning" className="text-[10px]">
                              {rec.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 10. Emails Generating Table */}
                {activeCategory === 'generation-pending' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Contact Name</th>
                        <th className="px-3 py-2.5">Email</th>
                        <th className="px-3 py-2.5">Company</th>
                        <th className="px-3 py-2.5">Attempts</th>
                        <th className="px-3 py-2.5">Generation Status</th>
                        <th className="px-3 py-2.5">Enqueued At</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as GenerationPendingRecord[]).map((rec) => (
                        <tr key={rec.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.contactName || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{rec.email}</td>
                          <td className="px-3 py-2.5 text-foreground">{rec.companyName || '—'}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">Attempt {rec.generationAttemptCount}</td>
                          <td className="px-3 py-2.5">
                            <Badge variant="outline" className="text-[10px] text-blue-600 bg-blue-50 border-blue-200">
                              {rec.generationStatus}
                            </Badge>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground font-mono text-[11px]">
                            {formatDateTime(rec.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 11. Generation Retry Table */}
                {activeCategory === 'generation-retry' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Contact Name</th>
                        <th className="px-3 py-2.5">Email</th>
                        <th className="px-3 py-2.5">Company</th>
                        <th className="px-3 py-2.5">Attempt Count</th>
                        <th className="px-3 py-2.5">Last Error Category</th>
                        <th className="px-3 py-2.5">Next Retry Scheduled</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as GenerationRetryRecord[]).map((rec) => (
                        <tr key={rec.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.contactName || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{rec.email}</td>
                          <td className="px-3 py-2.5 text-foreground">{rec.companyName || '—'}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.generationAttemptCount}</td>
                          <td className="px-3 py-2.5 text-orange-600 font-mono text-[11px]">
                            {rec.lastGenerationErrorCategory || 'transient_failure'}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground font-mono text-[11px]">
                            {rec.nextGenerationRetryAt ? formatDateTime(rec.nextGenerationRetryAt) : 'Pending'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 12. Generation Failed Table */}
                {activeCategory === 'generation-failed' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Contact Name</th>
                        <th className="px-3 py-2.5">Email</th>
                        <th className="px-3 py-2.5">Company</th>
                        <th className="px-3 py-2.5">Provider</th>
                        <th className="px-3 py-2.5">Attempts</th>
                        <th className="px-3 py-2.5">Error Message</th>
                        <th className="px-3 py-2.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as GenerationFailedRecord[]).map((rec) => (
                        <tr key={rec.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.contactName || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{rec.email}</td>
                          <td className="px-3 py-2.5 text-foreground">{rec.companyName || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                            {rec.generationProvider}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground">{rec.generationAttemptCount}</td>
                          <td className="px-3 py-2.5 text-red-600 max-w-xs truncate" title={rec.errorMessage || ''}>
                            {rec.errorMessage || 'Generation failed'}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setInspectFailure(rec)}
                              className="h-7 text-[11px] px-2"
                            >
                              Inspect
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 13. Ready to Send Table */}
                {activeCategory === 'ready-to-send' && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-border bg-muted/40 font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">Contact Name</th>
                        <th className="px-3 py-2.5">Email</th>
                        <th className="px-3 py-2.5">Company</th>
                        <th className="px-3 py-2.5">Generated Subject Line</th>
                        <th className="px-3 py-2.5">Strategy</th>
                        <th className="px-3 py-2.5 text-right">Preview</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(detailRecords as ReadyToSendRecord[]).map((rec) => (
                        <tr key={rec.id} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-foreground">{rec.contactName || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{rec.email}</td>
                          <td className="px-3 py-2.5 text-foreground">{rec.companyName || '—'}</td>
                          <td className="px-3 py-2.5 font-medium text-foreground max-w-xs truncate" title={rec.emailSubject}>
                            {rec.emailSubject}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge variant="outline" className="text-[10px]">
                              {rec.emailStrategy || 'direct'}
                            </Badge>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPreviewEmail(rec)}
                              className="h-7 text-[11px] px-2.5 gap-1"
                            >
                              <Mail className="h-3 w-3" />
                              View Email
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Pagination Controls */}
            {detailTotalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border mt-4 pt-3 text-xs text-muted-foreground">
                <span>
                  Page {detailPage} of {detailTotalPages} ({detailTotal} total items)
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={detailPage <= 1 || loadingDetail}
                    onClick={() => {
                      const prevPage = Math.max(1, detailPage - 1);
                      setDetailPage(prevPage);
                      fetchProcessingData(false, activeCategory, prevPage, detailSearch);
                    }}
                    className="h-7 px-2.5 text-xs"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={detailPage >= detailTotalPages || loadingDetail}
                    onClick={() => {
                      const nextPage = detailPage + 1;
                      setDetailPage(nextPage);
                      fetchProcessingData(false, activeCategory, nextPage, detailSearch);
                    }}
                    className="h-7 px-2.5 text-xs"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── EMAIL PREVIEW MODAL ── */}
      {previewEmail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-primary" />
                <h3 className="text-base font-bold text-foreground">Outreach Email Preview</h3>
              </div>
              <button
                onClick={() => setPreviewEmail(null)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">To:</span>
                  <span className="font-semibold text-foreground">
                    {previewEmail.contactName ? `${previewEmail.contactName} <${previewEmail.email}>` : previewEmail.email}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Company:</span>
                  <span className="font-medium text-foreground">{previewEmail.companyName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Strategy:</span>
                  <Badge variant="outline" className="text-[10px]">
                    {previewEmail.emailStrategy || 'direct'}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subject:</span>
                  <span className="font-bold text-foreground">{previewEmail.emailSubject}</span>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-4 space-y-2">
                <p className="font-semibold text-foreground text-xs uppercase tracking-wider">Email Body:</p>
                <div className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground bg-muted/10 p-3 rounded border border-border/50">
                  {previewEmail.emailBody}
                </div>
              </div>

              <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-3 text-xs text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Ready to Send:</span> This email is staged in the outreach queue and
                  adheres to daily quotas and send windows.
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end border-t border-border bg-muted/30 px-5 py-3">
              <Button variant="secondary" size="sm" onClick={() => setPreviewEmail(null)}>
                Close Preview
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── GENERATION FAILURE INSPECTION MODAL ── */}
      {inspectFailure && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xl rounded-xl border border-border bg-card shadow-xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <h3 className="text-base font-bold text-foreground">Generation Failure Details</h3>
              </div>
              <button
                onClick={() => setInspectFailure(null)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3.5 text-xs">
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1.5 font-mono text-[11px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Contact:</span>
                  <span className="text-foreground">{inspectFailure.contactName || 'Unnamed'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Email:</span>
                  <span className="text-foreground">{inspectFailure.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Company:</span>
                  <span className="text-foreground">{inspectFailure.companyName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Provider:</span>
                  <span className="text-foreground">{inspectFailure.generationProvider}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Attempts:</span>
                  <span className="text-foreground">{inspectFailure.generationAttemptCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Timestamp:</span>
                  <span className="text-foreground">
                    {inspectFailure.failureTimestamp ? formatDateTime(inspectFailure.failureTimestamp) : '—'}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 space-y-1.5">
                <span className="font-bold text-red-900 dark:text-red-300 uppercase tracking-wider text-[11px]">
                  Error Diagnostic:
                </span>
                <div className="font-mono text-xs text-red-800 dark:text-red-300 whitespace-pre-wrap break-all bg-red-100/50 dark:bg-red-900/30 p-2.5 rounded border border-red-200/60">
                  {inspectFailure.errorMessage || 'No specific error message recorded.'}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end border-t border-border bg-muted/30 px-5 py-3">
              <Button variant="secondary" size="sm" onClick={() => setInspectFailure(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE CONFIRMATION MODAL ── */}
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
