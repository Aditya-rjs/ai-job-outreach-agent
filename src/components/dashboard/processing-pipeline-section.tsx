'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Building2,
  Sparkles,
  RefreshCw,
  Send,
  Search,
  CheckCircle2,
  AlertTriangle,
  User,
  Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ProcessingPipelineStats } from '@/lib/processing-queries';

export type ProcessingCategory =
  | 'classification-pending'
  | 'classification-retry-waiting'
  | 'generation-pending'
  | 'generation-retry'
  | 'generation-failed'
  | 'ready-to-send';

interface ProcessingPipelineSectionProps {
  refreshTrigger?: number;
  selectedCategory?: ProcessingCategory;
  onCategoryChange?: (category: ProcessingCategory) => void;
}

export function ProcessingPipelineSection({
  refreshTrigger,
}: ProcessingPipelineSectionProps) {
  const [stats, setStats] = useState<ProcessingPipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Fetch processing stats
  const fetchData = useCallback(async (isManual = false) => {
    if (isManual) {
      setIsRefreshing(true);
    }
    try {
      const queryParams = new URLSearchParams({
        limit: '1',
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
        setLastUpdated(new Date(json.data.lastUpdated));
      }
    } catch (err) {
      console.error('Error in ProcessingPipelineSection fetchData:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Initial load and periodic background poll
  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      fetchData();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Re-fetch when parent trigger fires
  useEffect(() => {
    if (refreshTrigger) {
      fetchData();
    }
  }, [refreshTrigger, fetchData]);

  return (
    <section className="space-y-4 pt-2 min-w-0 w-full max-w-full">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/70 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-bold tracking-tight text-foreground">AI Outreach Processing</h3>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              Live Pipeline
            </span>
            {stats?.currentBatchFilename && (
              <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                Batch: {stats.currentBatchFilename}
              </span>
            )}
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

      {/* 13 Dashboard Metrics in 3 Rows */}
      <div className="space-y-3">
        {/* Row 1: 5 cards */}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {/* 1. Companies Found */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 truncate">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  Companies Found
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.companiesFound ?? 0}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Unique companies in batch
            </p>
          </div>

          {/* 2. Duplicate Companies */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 truncate">
                  <Layers className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  Duplicate Companies
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.duplicateCompanies ?? 0}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Normalized company duplicates
            </p>
          </div>

          {/* 3. AI Search Pending */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5 truncate">
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  AI Search Pending
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.aiSearchPending ?? 0}
                </p>
              </div>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
                Active
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Awaiting domain & job classification
            </p>
          </div>

          {/* 4. AI Search Retry */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-yellow-700 dark:text-yellow-400 flex items-center gap-1.5 truncate">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                  AI Search Retry
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.aiSearchRetry ?? 0}
                </p>
              </div>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-yellow-100 text-yellow-800 border border-yellow-300 shrink-0">
                Waiting
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Unresolved in current round
            </p>
          </div>

          {/* 5. AI Processed */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 truncate">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  AI Processed
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.aiProcessed ?? 0}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Terminal classification reached
            </p>
          </div>
        </div>

        {/* Row 2: 5 cards */}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {/* 6. Irrelevant Companies */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 truncate">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                  Irrelevant Companies
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.irrelevantCompanies ?? 0}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Outside outreach scope
            </p>
          </div>

          {/* 7. CS/IT Relevant */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 truncate">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                  CS/IT Relevant
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.csItRelevant ?? 0}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Confirmed CS/IT companies
            </p>
          </div>

          {/* 8. Contacts Found */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 truncate">
                  <User className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  Contacts Found
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.contactsFound ?? 0}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Total contacts imported
            </p>
          </div>

          {/* 9. Duplicate Contacts */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 truncate">
                  <Layers className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  Duplicate Contacts
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.duplicateContacts ?? 0}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Duplicate email contacts
            </p>
          </div>

          {/* 10. Emails Generating */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-1.5 truncate">
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  Emails Generating
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.emailsGenerating ?? 0}
                </p>
              </div>
              {((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0) ? (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
                  Blocked
                </span>
              ) : (stats?.emailsGenerating ?? 0) > 0 ? (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-300 shrink-0">
                  Active
                </span>
              ) : (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-muted text-muted-foreground border border-border shrink-0">
                  Idle
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              {((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0)
                ? 'Classification incomplete'
                : (stats?.emailsGenerating ?? 0) > 0
                  ? 'Generating emails'
                  : 'All emails generated'}
            </p>
          </div>
        </div>

        {/* Row 3: 3 cards */}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 lg:grid-cols-3">
          {/* 11. Generation Retry */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-orange-700 dark:text-orange-400 flex items-center gap-1.5 truncate">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                  Generation Retry
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.generationRetry ?? 0}
                </p>
              </div>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-bold shrink-0',
                  ((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0)
                    ? 'bg-amber-100 text-amber-800 border border-amber-300'
                    : (stats?.emailsGenerating ?? 0) > 0 && (stats?.generationRetry ?? 0) > 0
                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                      : (stats?.generationRetry ?? 0) > 0
                        ? 'bg-orange-100 text-orange-800 border border-orange-300'
                        : 'bg-muted text-muted-foreground border border-border'
                )}
              >
                {((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0)
                  ? 'Blocked'
                  : (stats?.emailsGenerating ?? 0) > 0 && (stats?.generationRetry ?? 0) > 0
                    ? 'Waiting'
                    : (stats?.generationRetry ?? 0) > 0
                      ? 'Eligible'
                      : 'Idle'}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              {((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0)
                ? 'Classification incomplete'
                : (stats?.emailsGenerating ?? 0) > 0 && (stats?.generationRetry ?? 0) > 0
                  ? 'Waiting for active pass'
                  : (stats?.generationRetry ?? 0) > 0
                    ? 'Generation retries eligible'
                    : 'No retries pending'}
            </p>
          </div>

          {/* 12. Generation Failed */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-red-700 dark:text-red-400 flex items-center gap-1.5 truncate">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Generation Failed
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.generationFailed ?? 0}
                </p>
              </div>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-bold border shrink-0',
                  ((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0)
                    ? 'bg-amber-100 text-amber-800 border-amber-300'
                    : (stats?.generationFailed ?? 0) > 0
                      ? 'bg-red-100 text-red-800 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-800'
                      : 'bg-muted text-muted-foreground border-border'
                )}
              >
                {((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0)
                  ? 'Blocked'
                  : (stats?.generationFailed ?? 0) > 0
                    ? 'Terminal'
                    : 'None'}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              {((stats?.aiSearchPending ?? 0) > 0 || (stats?.aiSearchRetry ?? 0) > 0)
                ? 'Classification incomplete'
                : 'Permanent generation failure'}
            </p>
          </div>

          {/* 13. Ready to Send */}
          <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm flex flex-col justify-between min-h-[105px] min-w-0">
            <div className="flex items-start justify-between gap-1.5">
              <div className="space-y-1 min-w-0">
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 truncate">
                  <Send className="h-3.5 w-3.5 shrink-0" />
                  Ready to Send
                </span>
                <p className="text-2xl font-bold text-foreground">
                  {stats?.readyToSend ?? 0}
                </p>
              </div>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 shrink-0">
                Staged
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight truncate">
              Personalized emails staged
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
