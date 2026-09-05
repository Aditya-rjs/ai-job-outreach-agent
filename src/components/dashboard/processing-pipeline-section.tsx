'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Building2,
  Sparkles,
  RefreshCw,
  Send,
  ChevronDown,
  ChevronRight,
  Search,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Mail,
  User,
  ExternalLink,
  Layers,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn, formatDateTime } from '@/lib/utils';
import type {
  ProcessingPipelineStats,
  ClassificationPendingRecord,
  CompanyContactItem,
  GenerationPendingRecord,
  GenerationRetryRecord,
  ReadyToSendRecord,
} from '@/lib/processing-queries';

export type ProcessingCategory =
  | 'classification-pending'
  | 'generation-pending'
  | 'generation-retry'
  | 'ready-to-send';

interface ProcessingPipelineSectionProps {
  // Can be called to trigger a parent sync or refresh trigger
  refreshTrigger?: number;
}

export function ProcessingPipelineSection({ refreshTrigger }: ProcessingPipelineSectionProps) {
  const [activeCategory, setActiveCategory] = useState<ProcessingCategory>('classification-pending');
  const [stats, setStats] = useState<ProcessingPipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Category records state
  const [classRecords, setClassRecords] = useState<ClassificationPendingRecord[]>([]);
  const [genPendingRecords, setGenPendingRecords] = useState<GenerationPendingRecord[]>([]);
  const [genRetryRecords, setGenRetryRecords] = useState<GenerationRetryRecord[]>([]);
  const [readyToSendRecords, setReadyToSendRecords] = useState<ReadyToSendRecord[]>([]);

  // Expanded company state for Classification Pending
  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>({});
  const [companyContacts, setCompanyContacts] = useState<Record<string, CompanyContactItem[]>>({});
  const [loadingCompanyContacts, setLoadingCompanyContacts] = useState<Record<string, boolean>>({});

  // Read-only email preview modal for Ready to Send
  const [previewEmail, setPreviewEmail] = useState<ReadyToSendRecord | null>(null);

  // Fetch processing data
  const fetchData = useCallback(
    async (isManual = false, targetCategory = activeCategory, targetPage = page, targetSearch = search) => {
      if (isManual) {
        setIsRefreshing(true);
      }
      try {
        const queryParams = new URLSearchParams({
          category: targetCategory,
          page: String(targetPage),
          limit: '20',
          search: targetSearch.trim(),
          _t: String(Date.now()),
        });

        const res = await fetch(`/api/dashboard/processing?${queryParams.toString()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        });

        if (!res.ok) throw new Error('Failed to fetch processing data');
        const json = await res.json();

        if (json.success && json.data) {
          setStats(json.data.stats);
          setTotal(json.data.total);
          setTotalPages(json.data.totalPages);
          setLastUpdated(new Date(json.data.lastUpdated));

          if (targetCategory === 'classification-pending') {
            setClassRecords(json.data.records as ClassificationPendingRecord[]);
          } else if (targetCategory === 'generation-pending') {
            setGenPendingRecords(json.data.records as GenerationPendingRecord[]);
          } else if (targetCategory === 'generation-retry') {
            setGenRetryRecords(json.data.records as GenerationRetryRecord[]);
          } else if (targetCategory === 'ready-to-send') {
            setReadyToSendRecords(json.data.records as ReadyToSendRecord[]);
          }
        }
      } catch (err) {
        console.error('Error in ProcessingPipelineSection fetchData:', err);
      } finally {
        setLoading(false);
        setIsRefreshing(false);
      }
    },
    [activeCategory, page, search]
  );

  // Re-fetch whenever activeCategory or page changes
  useEffect(() => {
    fetchData(false, activeCategory, page, search);
  }, [activeCategory, page, fetchData]);

  // Synchronize when parent refreshTrigger fires
  useEffect(() => {
    if (refreshTrigger) {
      fetchData(false);
    }
  }, [refreshTrigger, fetchData]);

  // Handle category switch
  const handleSelectCategory = (cat: ProcessingCategory) => {
    setActiveCategory(cat);
    setPage(1);
    setSearch('');
  };

  // Handle search submission / change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearch(val);
    setPage(1);
    fetchData(false, activeCategory, 1, val);
  };

  // Expand / collapse company contacts
  const toggleCompanyExpand = async (normalizedName: string) => {
    const isCurrentlyExpanded = Boolean(expandedCompanies[normalizedName]);
    const nextState = !isCurrentlyExpanded;

    setExpandedCompanies((prev) => ({ ...prev, [normalizedName]: nextState }));

    // Fetch contacts if not already cached
    if (nextState && !companyContacts[normalizedName]) {
      setLoadingCompanyContacts((prev) => ({ ...prev, [normalizedName]: true }));
      try {
        const res = await fetch(
          `/api/dashboard/processing?companyContacts=${encodeURIComponent(normalizedName)}&_t=${Date.now()}`,
          { cache: 'no-store' }
        );
        const json = await res.json();
        if (json.success && json.data?.contacts) {
          setCompanyContacts((prev) => ({ ...prev, [normalizedName]: json.data.contacts }));
        }
      } catch (err) {
        console.error('Failed to fetch company contacts:', err);
      } finally {
        setLoadingCompanyContacts((prev) => ({ ...prev, [normalizedName]: false }));
      }
    }
  };

  return (
    <section className="space-y-4 pt-2">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/70 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-bold tracking-tight text-foreground">AI Outreach Processing</h3>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              Live Pipeline
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real-time stage tracking: company classification, autonomous personalized email generation, retries, and send readiness.
          </p>
        </div>

        <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
          {lastUpdated && (
            <span className="hidden sm:inline font-mono text-[11px]">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchData(true)}
            disabled={isRefreshing || loading}
            className="h-8 gap-1.5 text-xs"
            title="Refresh processing status"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* 4 Summary Processing Cards */}
      <div className="grid gap-3.5 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {/* 1. Classification Pending */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => handleSelectCategory('classification-pending')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelectCategory('classification-pending');
            }
          }}
          className={cn(
            'rounded-xl border p-4 shadow-sm transition-all cursor-pointer flex flex-col justify-between min-h-[116px]',
            activeCategory === 'classification-pending'
              ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20 ring-2 ring-amber-500/20'
              : 'border-border bg-card hover:border-amber-400/60 hover:bg-card/90'
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <Building2 className="h-3.5 w-3.5 shrink-0" />
                Classification Pending
              </span>
              <p className="text-2xl font-bold text-foreground">
                {stats?.classificationPendingCount ?? 0}
              </p>
            </div>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
              Companies
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 leading-tight">
            Gemini evaluating company domain & job relevance. Auto-retries on rate limits.
          </p>
        </div>

        {/* 2. Email Generation Pending */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => handleSelectCategory('generation-pending')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelectCategory('generation-pending');
            }
          }}
          className={cn(
            'rounded-xl border p-4 shadow-sm transition-all cursor-pointer flex flex-col justify-between min-h-[116px]',
            activeCategory === 'generation-pending'
              ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 ring-2 ring-blue-500/20'
              : 'border-border bg-card hover:border-blue-400/60 hover:bg-card/90'
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <span className="text-xs font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-1">
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                Email Gen Pending
              </span>
              <p className="text-2xl font-bold text-foreground">
                {stats?.emailGenerationPendingCount ?? 0}
              </p>
            </div>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-300 shrink-0">
              Relevant
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 leading-tight">
            Confirmed relevant contacts waiting for background worker to craft email body.
          </p>
        </div>

        {/* 3. Generation Retry */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => handleSelectCategory('generation-retry')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelectCategory('generation-retry');
            }
          }}
          className={cn(
            'rounded-xl border p-4 shadow-sm transition-all cursor-pointer flex flex-col justify-between min-h-[116px]',
            activeCategory === 'generation-retry'
              ? 'border-orange-500 bg-orange-50/50 dark:bg-orange-950/20 ring-2 ring-orange-500/20'
              : 'border-border bg-card hover:border-orange-400/60 hover:bg-card/90'
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <span className="text-xs font-semibold text-orange-700 dark:text-orange-400 flex items-center gap-1">
                <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                Generation Retry
              </span>
              <p className="text-2xl font-bold text-foreground">
                {stats?.generationRetryCount ?? 0}
              </p>
            </div>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-orange-100 text-orange-800 border border-orange-300 shrink-0">
              Backoff
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 leading-tight">
            Encountered transient rate limit or timeout. Retrying automatically with backoff.
          </p>
        </div>

        {/* 4. Ready to Send */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => handleSelectCategory('ready-to-send')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelectCategory('ready-to-send');
            }
          }}
          className={cn(
            'rounded-xl border p-4 shadow-sm transition-all cursor-pointer flex flex-col justify-between min-h-[116px]',
            activeCategory === 'ready-to-send'
              ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20 ring-2 ring-emerald-500/20'
              : 'border-border bg-card hover:border-emerald-400/60 hover:bg-card/90'
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                <Send className="h-3.5 w-3.5 shrink-0" />
                Ready to Send
              </span>
              <p className="text-2xl font-bold text-foreground">
                {stats?.readyToSendCount ?? 0}
              </p>
            </div>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 shrink-0">
              Staged
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 leading-tight">
            Personalized emails generated, resume ready, staged for daily sending window.
          </p>
        </div>
      </div>

      {/* Detailed Workbench Card */}
      <Card className="border border-border bg-card shadow-sm">
        <CardContent className="p-4 sm:p-5 space-y-4">
          {/* Controls Bar: Category Tabs + Search */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-border pb-3">
            {/* Category Navigation Tabs */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
              <button
                type="button"
                onClick={() => handleSelectCategory('classification-pending')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap',
                  activeCategory === 'classification-pending'
                    ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span>Classification Pending</span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.2 text-[10px]',
                    activeCategory === 'classification-pending'
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted-foreground/15 text-muted-foreground'
                  )}
                >
                  {stats?.classificationPendingCount ?? 0}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectCategory('generation-pending')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap',
                  activeCategory === 'generation-pending'
                    ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span>Email Gen Pending</span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.2 text-[10px]',
                    activeCategory === 'generation-pending'
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted-foreground/15 text-muted-foreground'
                  )}
                >
                  {stats?.emailGenerationPendingCount ?? 0}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectCategory('generation-retry')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap',
                  activeCategory === 'generation-retry'
                    ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span>Generation Retry</span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.2 text-[10px]',
                    activeCategory === 'generation-retry'
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted-foreground/15 text-muted-foreground'
                  )}
                >
                  {stats?.generationRetryCount ?? 0}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectCategory('ready-to-send')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap',
                  activeCategory === 'ready-to-send'
                    ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span>Ready to Send</span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.2 text-[10px]',
                    activeCategory === 'ready-to-send'
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted-foreground/15 text-muted-foreground'
                  )}
                >
                  {stats?.readyToSendCount ?? 0}
                </span>
              </button>
            </div>

            {/* Instant Search Bar */}
            <div className="relative w-full md:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={handleSearchChange}
                placeholder="Search company, contact, email..."
                className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* TABLE CONTENT AREA */}
          <div className="min-h-[220px]">
            {loading ? (
              <div className="py-12 flex flex-col items-center justify-center text-muted-foreground gap-2">
                <RefreshCw className="h-6 w-6 animate-spin text-primary" />
                <p className="text-xs">Loading processing records...</p>
              </div>
            ) : total === 0 ? (
              <div className="py-12 text-center text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2 opacity-80" />
                <p className="text-sm font-semibold text-foreground">
                  {search ? 'No records match your search' : 'No records in this category'}
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  {activeCategory === 'classification-pending' &&
                    'All companies have completed Gemini classification! Check the dashboard cards for results.'}
                  {activeCategory === 'generation-pending' &&
                    'No relevant contacts waiting for initial email generation.'}
                  {activeCategory === 'generation-retry' &&
                    'Zero generation errors! Background generator is running cleanly.'}
                  {activeCategory === 'ready-to-send' &&
                    'No generated emails currently staged in queue.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                {/* 1. CLASSIFICATION PENDING VIEW (Company-level grouping + expandable contacts) */}
                {activeCategory === 'classification-pending' && (
                  <div className="divide-y divide-border/60">
                    <div className="grid grid-cols-12 gap-2 pb-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-2">
                      <div className="col-span-4 sm:col-span-3">Company</div>
                      <div className="col-span-3 sm:col-span-3">Representative Contacts</div>
                      <div className="col-span-2 sm:col-span-2">Retry Attempt</div>
                      <div className="col-span-3 sm:col-span-4 text-right">Classification Status</div>
                    </div>

                    {classRecords.map((record) => {
                      const isExpanded = Boolean(expandedCompanies[record.normalizedName]);
                      const contactsForCompany = companyContacts[record.normalizedName] || [];
                      const isLoadingContacts = Boolean(loadingCompanyContacts[record.normalizedName]);

                      return (
                        <div key={record.normalizedName} className="py-2.5 px-2 hover:bg-muted/30 transition-colors rounded-lg">
                          <div className="grid grid-cols-12 gap-2 items-center text-xs">
                            {/* Company Name & Expand toggle */}
                            <div className="col-span-4 sm:col-span-3 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => toggleCompanyExpand(record.normalizedName)}
                                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                title={isExpanded ? 'Collapse contacts' : 'Expand contacts'}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-primary" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </button>
                              <div className="min-w-0">
                                <p className="font-semibold text-foreground truncate">{record.companyName}</p>
                                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                  <User className="h-3 w-3" />
                                  {record.contactCount} contact{record.contactCount === 1 ? '' : 's'}
                                </span>
                              </div>
                            </div>

                            {/* Representative Contacts Preview */}
                            <div className="col-span-3 sm:col-span-3 text-[11px] text-muted-foreground truncate">
                              {record.representativeContacts.length > 0
                                ? record.representativeContacts.slice(0, 2).join(' • ')
                                : record.contactEmails.slice(0, 2).join(', ')}
                              {record.contactCount > 2 && (
                                <span className="text-muted-foreground/60 ml-1">+{record.contactCount - 2} more</span>
                              )}
                            </div>

                            {/* Retry Attempt & Model */}
                            <div className="col-span-2 sm:col-span-2">
                              <span className="font-medium text-foreground text-xs">
                                Retry #{record.retryCount}
                              </span>
                              {record.lastErrorCategory && (
                                <p className="text-[10px] text-amber-700 dark:text-amber-400 font-mono truncate">
                                  {record.lastErrorCategory}
                                </p>
                              )}
                            </div>

                            {/* Status & Next Retry */}
                            <div className="col-span-3 sm:col-span-4 flex flex-col items-end gap-0.5">
                              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                                Classification Pending — Retrying automatically
                              </span>
                              {record.nextRetryAt && (
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  Next retry: {new Date(record.nextRetryAt).toLocaleTimeString()}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Expanded Contact List for this Company */}
                          {isExpanded && (
                            <div className="mt-2.5 ml-6 pl-3 border-l-2 border-primary/30 py-2 space-y-1.5 bg-muted/20 rounded-r-lg">
                              <p className="text-[11px] font-semibold text-foreground mb-1">
                                Contacts at {record.companyName} ({record.contactCount}):
                              </p>
                              {isLoadingContacts ? (
                                <div className="text-xs text-muted-foreground flex items-center gap-1.5 py-1">
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                  Loading company contacts...
                                </div>
                              ) : contactsForCompany.length === 0 ? (
                                <p className="text-xs text-muted-foreground">No contacts found for this company.</p>
                              ) : (
                                <div className="space-y-1">
                                  {contactsForCompany.map((contact) => (
                                    <div
                                      key={contact.id}
                                      className="flex flex-col sm:flex-row sm:items-center justify-between text-xs py-1 px-2 rounded hover:bg-muted/40 gap-1"
                                    >
                                      <div className="flex items-center gap-2">
                                        <span className="font-medium text-foreground">
                                          {contact.contactName || 'Unnamed Contact'}
                                        </span>
                                        <span className="text-muted-foreground font-mono text-[11px]">
                                          {contact.email}
                                        </span>
                                        {contact.designation && (
                                          <span className="text-[10px] bg-muted px-1.5 py-0.2 rounded text-muted-foreground">
                                            {contact.designation}
                                          </span>
                                        )}
                                      </div>
                                      <span className="text-[10px] text-muted-foreground shrink-0">
                                        Batch: {contact.batchFilename}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 2. EMAIL GENERATION PENDING VIEW */}
                {activeCategory === 'generation-pending' && (
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-border/70 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <th className="py-2.5 px-3">Recipient</th>
                        <th className="py-2.5 px-3">Company</th>
                        <th className="py-2.5 px-3">Email</th>
                        <th className="py-2.5 px-3">Generation Status</th>
                        <th className="py-2.5 px-3">Attempt</th>
                        <th className="py-2.5 px-3 text-right">Batch</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {genPendingRecords.map((r) => (
                        <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 px-3 font-medium text-foreground">
                            {r.contactName || 'Unknown Recipient'}
                          </td>
                          <td className="py-2.5 px-3 text-muted-foreground">{r.companyName || '—'}</td>
                          <td className="py-2.5 px-3 font-mono text-[11px] text-muted-foreground">{r.email}</td>
                          <td className="py-2.5 px-3">
                            {r.generationStatus === 'GENERATING' ? (
                              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-blue-100 text-blue-900 border border-blue-300">
                                <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-ping" />
                                Generating email...
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-800 border border-slate-300">
                                <Clock className="h-3 w-3 text-slate-500" />
                                Pending generation
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-muted-foreground">
                            #{r.generationAttemptCount}
                          </td>
                          <td className="py-2.5 px-3 text-right text-muted-foreground text-[11px] truncate max-w-[150px]">
                            {r.batchFilename}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 3. GENERATION RETRY VIEW */}
                {activeCategory === 'generation-retry' && (
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-border/70 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <th className="py-2.5 px-3">Recipient</th>
                        <th className="py-2.5 px-3">Company</th>
                        <th className="py-2.5 px-3">Email</th>
                        <th className="py-2.5 px-3">Error Category</th>
                        <th className="py-2.5 px-3">Attempt #</th>
                        <th className="py-2.5 px-3">Next Retry</th>
                        <th className="py-2.5 px-3 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {genRetryRecords.map((r) => (
                        <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 px-3 font-medium text-foreground">
                            {r.contactName || 'Unknown Recipient'}
                          </td>
                          <td className="py-2.5 px-3 text-muted-foreground">{r.companyName || '—'}</td>
                          <td className="py-2.5 px-3 font-mono text-[11px] text-muted-foreground">{r.email}</td>
                          <td className="py-2.5 px-3">
                            <span className="font-mono text-[11px] font-semibold text-orange-700 dark:text-orange-400 bg-orange-50 px-1.5 py-0.5 rounded border border-orange-200">
                              {r.lastGenerationErrorCategory || 'TRANSIENT_ERROR'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-muted-foreground font-medium">
                            Attempt {r.generationAttemptCount}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-[11px] text-muted-foreground">
                            {r.nextGenerationRetryAt ? new Date(r.nextGenerationRetryAt).toLocaleTimeString() : 'Scheduled'}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-orange-100 text-orange-900 border border-orange-300">
                              <span className="h-1.5 w-1.5 rounded-full bg-orange-500 animate-pulse" />
                              Retrying automatically
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* 4. READY TO SEND VIEW */}
                {activeCategory === 'ready-to-send' && (
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-border/70 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <th className="py-2.5 px-3">Recipient & Company</th>
                        <th className="py-2.5 px-3">Email</th>
                        <th className="py-2.5 px-3">Subject Preview</th>
                        <th className="py-2.5 px-3">Generated At</th>
                        <th className="py-2.5 px-3">Queue Status</th>
                        <th className="py-2.5 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {readyToSendRecords.map((r) => (
                        <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 px-3">
                            <p className="font-medium text-foreground">{r.contactName || 'Recipient'}</p>
                            <span className="text-[11px] text-muted-foreground">{r.companyName || '—'}</span>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-[11px] text-muted-foreground">{r.email}</td>
                          <td className="py-2.5 px-3 max-w-[220px]">
                            <p className="font-medium text-foreground truncate">{r.emailSubject}</p>
                            {r.emailStrategy && (
                              <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded">
                                {r.emailStrategy}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-[11px] text-muted-foreground">
                            {r.generatedAt ? formatDateTime(r.generatedAt) : 'Ready'}
                          </td>
                          <td className="py-2.5 px-3">
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-900 border border-emerald-300">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Ready to Send
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPreviewEmail(r)}
                              className="h-7 px-2.5 text-[11px] gap-1"
                              title="Read-only email inspection"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Preview
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
              <span>
                Showing page {page} of {totalPages} ({total} total records)
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="h-8 px-3 text-xs"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="h-8 px-3 text-xs"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Read-Only Email Preview Modal */}
      {previewEmail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-xl rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-start justify-between border-b border-border pb-3">
              <div>
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                  Ready to Send • Read-Only Inspection
                </span>
                <h4 className="text-lg font-bold text-foreground mt-0.5">{previewEmail.emailSubject}</h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  To: {previewEmail.contactName} &lt;{previewEmail.email}&gt; • {previewEmail.companyName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewEmail(null)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto bg-muted/30 p-4 rounded-lg text-xs leading-relaxed font-sans text-foreground whitespace-pre-wrap border border-border/50">
              {previewEmail.emailBody}
            </div>

            <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5 text-[11px]">
                <Info className="h-3.5 w-3.5 text-primary" />
                Informational only. This dialog does not send emails.
              </span>
              <Button size="sm" variant="outline" onClick={() => setPreviewEmail(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
