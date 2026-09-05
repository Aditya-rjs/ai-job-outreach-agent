'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Building2,
  CheckCircle2,
  Send,
  Clock,
  AlertCircle,
  Inbox,
  ArrowRight,
  Upload,
  RefreshCw,
  Layers,
  Pause,
  Play,
  Square,
  Zap,
  Sparkles,
} from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/utils';
import type { DashboardStats, Batch, SchedulerConfig } from '@/types';
import { DashboardDetailModal, type DashboardCardViewId } from '@/components/dashboard/dashboard-detail-modal';

const POLL_INTERVAL_MS = 6000; // 6 seconds automatic refresh

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerConfig | null>(null);
  const [recentBatches, setRecentBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  // Active detail view for clickable dashboard cards
  const [activeModalView, setActiveModalView] = useState<DashboardCardViewId | null>(null);

  // Read initial ?view= parameter from URL if available
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const initialView = params.get('view') as DashboardCardViewId | null;
      const validViews: DashboardCardViewId[] = [
        'total-companies',
        'relevant-tech',
        'contacts-found',
        'eligible-queued',
        'emails-generated',
        'emails-sent',
        'skipped-filtered',
      ];
      if (initialView && validViews.includes(initialView)) {
        setActiveModalView(initialView);
      }
    }
  }, []);

  const handleOpenCardView = (viewId: DashboardCardViewId) => {
    setActiveModalView(viewId);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('view', viewId);
      window.history.pushState({}, '', url.toString());
    }
  };

  const handleCloseCardView = () => {
    setActiveModalView(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('view');
      window.history.pushState({}, '', url.toString());
    }
  };

  // In-flight guard and response sequencing references
  const inFlightRef = useRef(false);
  const latestTimestampRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Fetches fresh dashboard, scheduler, and batch statistics.
   * Enforces:
   * 1. In-flight concurrency guard (requests cannot overlap).
   * 2. Cache-busting (cache: 'no-store' + timestamp parameter).
   * 3. Response sequencing (newest request always wins, older responses discarded).
   */
  const fetchDashboardData = useCallback(async (isManual = false) => {
    // 1. Guard against overlapping background requests
    if (inFlightRef.current) {
      if (!isManual) {
        // Background poll tick: skip if previous fetch is still running
        return;
      }
      // If manual refresh was clicked, abort previous in-flight request so manual refresh wins immediately
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }

    inFlightRef.current = true;
    if (isManual) {
      setIsRefreshing(true);
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const requestTimestamp = Date.now();
    latestTimestampRef.current = requestTimestamp;

    try {
      const [statsRes, schedulerRes, batchesRes] = await Promise.all([
        fetch(`/api/dashboard?_t=${requestTimestamp}`, {
          cache: 'no-store',
          signal: abortController.signal,
          headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        }),
        fetch(`/api/scheduler/status?_t=${requestTimestamp}`, {
          cache: 'no-store',
          signal: abortController.signal,
          headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        }),
        fetch(`/api/batches?_t=${requestTimestamp}`, {
          cache: 'no-store',
          signal: abortController.signal,
          headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        }),
      ]);

      const [statsJson, schedulerJson, batchesJson] = await Promise.all([
        statsRes.json(),
        schedulerRes.json(),
        batchesRes.json(),
      ]);

      // Response sequencing check: Ensure an old/delayed response cannot overwrite newer state
      if (requestTimestamp < latestTimestampRef.current) {
        return;
      }

      if (statsJson.success) setStats(statsJson.data);
      if (schedulerJson.success) setScheduler(schedulerJson.data);
      if (batchesJson.success) setRecentBatches((batchesJson.data || []).slice(0, 5));
      setLastSyncTime(new Date());
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Intentionally aborted for newer request
        return;
      }
      console.error('Error fetching dashboard stats:', err);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      if (isManual) {
        setIsRefreshing(false);
      }
    }
  }, []);

  // Polling lifecycle with browser tab visibility handling
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let isSubscribed = true;

    // Initial fetch on mount deferred via macro-task to avoid synchronous setState in effect
    const initialTimer = setTimeout(() => {
      if (isSubscribed) {
        fetchDashboardData(false);
      }
    }, 0);

    const startPolling = () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible' && isSubscribed) {
          fetchDashboardData(false);
        }
      }, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        // Tab foregrounded: immediately fetch fresh data and resume interval
        fetchDashboardData(false);
        startPolling();
      } else {
        // Tab hidden: pause polling to save resources
        stopPolling();
      }
    };

    const handleFocus = () => {
      fetchDashboardData(false);
    };

    startPolling();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus);
    }

    return () => {
      isSubscribed = false;
      clearTimeout(initialTimer);
      stopPolling();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchDashboardData]);

  const handlePause = async () => {
    setActionLoading(true);
    try {
      const res = await fetch('/api/scheduler/pause', { method: 'POST', cache: 'no-store' });
      const json = await res.json();
      if (json.success) {
        setScheduler(json.data);
        setStatusMessage('Scheduler paused. In-flight requests will finish, but no new emails will be sent.');
        await fetchDashboardData(true);
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async () => {
    setActionLoading(true);
    try {
      const res = await fetch('/api/scheduler/resume', { method: 'POST', cache: 'no-store' });
      const json = await res.json();
      if (json.success) {
        setScheduler(json.data);
        setStatusMessage('Scheduler resumed. Automatic daily sending active.');
        await fetchDashboardData(true);
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    if (!confirm('Stop outreach campaign? The queue will be preserved, but sending will halt completely until explicitly resumed.')) {
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch('/api/scheduler/stop', { method: 'POST', cache: 'no-store' });
      const json = await res.json();
      if (json.success) {
        setScheduler(json.data);
        setStatusMessage('Outreach campaign stopped. Progress and queue preserved.');
        await fetchDashboardData(true);
      }
    } finally {
      setActionLoading(false);
    }
  };

  // Check if any batch is completed
  const completedBatch = recentBatches.find((b) => b.status === 'completed');

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Real-time outreach overview, persistent queue, and scheduler state
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Live auto-refresh indicator */}
          <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 border border-border/60 rounded-lg px-2.5 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>Live sync active</span>
            {lastSyncTime && (
              <span className="text-[11px] text-muted-foreground/80 font-mono">
                • {lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchDashboardData(true)}
            disabled={loading || isRefreshing}
            title="Immediately fetch fresh data from database"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing || loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Link href="/upload">
            <Button size="sm">
              <Upload className="h-4 w-4" />
              Upload Contacts
            </Button>
          </Link>
        </div>
      </div>


      {statusMessage && (
        <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs font-medium text-primary">
          <span>{statusMessage}</span>
          <button onClick={() => setStatusMessage(null)} className="text-xs hover:underline ml-2">
            Dismiss
          </button>
        </div>
      )}

      {/* Real-Sending Safety Gate Banner (Requirement 21) */}
      {stats?.isDryRun ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950 flex items-start gap-3 shadow-xs">
          <div className="rounded-lg bg-amber-100 p-2 text-amber-800 shrink-0">
            <AlertCircle className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Badge variant="warning" className="uppercase tracking-wide font-bold bg-amber-200 text-amber-900 border-amber-400">
                DRY-RUN MODE ACTIVE
              </Badge>
              <span className="font-semibold text-amber-950">No real Gmail emails are being dispatched.</span>
            </div>
            <p className="text-amber-850 mt-1 font-medium">
              Simulation environment active. The persistent scheduler processes jobs, simulates 3-minute intervals, and tracks progress without dispatching real Gmail emails to recruiters.
            </p>
          </div>
        </div>
      ) : stats?.gmailConnected ? (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-4 text-xs text-emerald-950 flex items-start gap-3 shadow-xs">
          <div className="rounded-lg bg-emerald-100 p-2 text-emerald-800 shrink-0">
            <Send className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Badge variant="success" className="uppercase tracking-wide font-bold">LIVE OUTREACH SENDING IS ENABLED</Badge>
              <span className="font-semibold text-emerald-950">Authorized Account: {stats.gmailEmail}</span>
            </div>
            <p className="text-emerald-800 mt-1">
              When the background worker (<code className="font-mono text-xs">npm run worker</code>) is active, eligible emails will be dispatched to recruiters via your connected Gmail account at 10:00 AM IST (max {stats.dailyLimit}/day, 3-minute minimum gap).
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-muted/30 p-4 text-xs text-foreground flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <p className="font-semibold text-foreground">Production Mode (Gmail Disconnected)</p>
              <p className="text-muted-foreground text-[11px]">
                Live sending is disarmed because Gmail is not connected. Connect your Google account in Settings to enable real outreach.
              </p>
            </div>
          </div>
          <Link href="/settings">
            <Button size="sm" variant="outline">Connect Gmail</Button>
          </Link>
        </div>
      )}

      {/* Batch Completion Notice */}
      {completedBatch && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-900 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-bold text-emerald-950 text-sm">
              {stats?.isDryRun
                ? `All eligible simulated outreach from batch "${completedBatch.filename}" has finished!`
                : `All eligible emails from batch "${completedBatch.filename}" have been sent!`}
            </p>
            <p className="text-emerald-800 mt-1">
              {stats?.isDryRun
                ? `Simulated: ${completedBatch.emailsSimulated ?? completedBatch.emailsSent} • Skipped/Filtered: ${completedBatch.irrelevantCompanies + completedBatch.duplicateContacts} • Failed: ${completedBatch.emailsFailed} (Dry-Run: 0 real Gmail emails dispatched).`
                : `Sent: ${completedBatch.emailsSent} • Skipped/Filtered: ${completedBatch.irrelevantCompanies + completedBatch.duplicateContacts} • Failed: ${completedBatch.emailsFailed}.`}
              {' '}Upload another file to schedule additional outreach.
            </p>
          </div>
          <Link href="/upload">
            <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-950 hover:bg-emerald-100">
              Upload New File
            </Button>
          </Link>
        </div>
      )}

      {/* Persistent Scheduler Banner & Controls */}
      <Card className="border-primary/20 bg-card">
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-border pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Scheduler Status:</span>
                {scheduler?.isStopped ? (
                  <Badge variant="destructive">Stopped</Badge>
                ) : scheduler?.isPaused ? (
                  <Badge variant="warning">Paused</Badge>
                ) : !stats?.isDryRun && scheduler?.todaySentCount && scheduler.todaySentCount >= (scheduler?.dailyLimit ?? 30) ? (
                  <Badge variant="secondary">Daily Limit Reached (30/30)</Badge>
                ) : stats?.queueSize && stats.queueSize > 0 ? (
                  <Badge variant="success">Active Worker Ready</Badge>
                ) : (
                  <Badge variant="outline">Waiting for Contacts</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Sending Window Opens: 10:00 AM • 30 successful real emails/day • {scheduler?.intervalMinutes || 3}-min gap • Timezone: {scheduler?.timezone || 'Asia/Kolkata'}
              </p>
            </div>

            {/* Persistent Control Actions */}
            <div className="flex items-center gap-2">
              {scheduler?.isPaused || scheduler?.isStopped ? (
                <Button size="sm" onClick={handleResume} disabled={actionLoading} className="gap-1.5">
                  <Play className="h-3.5 w-3.5" />
                  Resume Outreach
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={handlePause} disabled={actionLoading} className="gap-1.5">
                  <Pause className="h-3.5 w-3.5" />
                  Pause
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                onClick={handleStop}
                disabled={actionLoading || scheduler?.isStopped}
                className="gap-1.5"
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            </div>
          </div>

          {/* Daily Limit Reached Notice Banner */}
          {!stats?.isDryRun && (stats?.todaySentCount ?? 0) >= (stats?.dailyLimit ?? 30) && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-4 py-2.5 text-xs text-amber-800 font-medium">
              Daily limit reached — remaining contacts will resume tomorrow at 10:00 AM.
            </div>
          )}

          {/* Today's Outreach Meter & Scheduling Details */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground font-medium">
                {stats?.isDryRun ? "Today's Simulated Outreach" : "Today's Outreach Sent"}
              </p>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-2xl font-bold text-foreground">
                  {stats?.isDryRun ? (stats?.todaySimulatedCount ?? 0) : (stats?.todaySentCount ?? 0)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {stats?.isDryRun ? 'simulated' : `/ ${stats?.dailyLimit ?? 30} real emails`}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {stats?.isDryRun
                  ? 'Simulated — no real emails sent.'
                  : (stats?.todaySentCount ?? 0) >= (stats?.dailyLimit ?? 30)
                    ? 'Daily limit reached — remaining contacts will resume tomorrow at 10:00 AM.'
                    : `Remaining today: ${stats?.remainingToday ?? 30}`}
              </p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground font-medium">Outreach Queue</p>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-2xl font-bold text-primary">{stats?.queueSize ?? 0}</span>
                <span className="text-sm text-muted-foreground">contacts staged</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {stats?.emailsGenerated ?? 0} ready • {stats?.emailsPendingGeneration ?? 0} pending gen
              </p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground font-medium">Next Scheduled Send</p>
              <p className="text-sm font-semibold text-foreground mt-1">
                {!stats?.isDryRun && (stats?.todaySentCount ?? 0) >= (stats?.dailyLimit ?? 30)
                  ? 'Tomorrow at 10:00 AM'
                  : stats?.nextSendAt
                    ? formatDateTime(stats.nextSendAt)
                    : 'Sending Window Opens: 10:00 AM'}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {!stats?.isDryRun && (stats?.todaySentCount ?? 0) >= (stats?.dailyLimit ?? 30)
                  ? 'Daily limit reached — remaining contacts will resume tomorrow at 10:00 AM.'
                  : stats?.lastSendAt
                    ? `Last sent: ${formatDateTime(stats.lastSendAt)}`
                    : 'No real emails sent today'}
              </p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground font-medium">Worker Lock / Lease</p>
              <div className="flex items-center gap-1.5 mt-1">
                <Zap className={`h-4 w-4 ${scheduler?.workerId ? 'text-emerald-600' : 'text-muted-foreground'}`} />
                <span className="text-xs font-mono font-medium text-foreground">
                  {scheduler?.workerId ? `${scheduler.workerId.slice(0, 16)}...` : 'Run `npm run worker`'}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {scheduler?.workerId
                  ? `Active background worker ${scheduler?.lastHeartbeatAt ? `• Heartbeat: ${formatDateTime(scheduler.lastHeartbeatAt)}` : ''}`
                  : 'Worker process is offline'}
              </p>
            </div>
          </div>

          {/* Autonomous AI Email Generation & Gemini Observability */}
          <div className="rounded-lg bg-secondary/50 p-3 text-xs border border-border/50 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Sparkles className="h-4 w-4 text-primary shrink-0" />
              <span className="font-semibold text-foreground">Autonomous AI Email Generation:</span>
              <span className="text-muted-foreground">
                {stats?.emailsGenerated ?? 0} Ready • {stats?.emailsPendingGeneration ?? 0} Pending • {stats?.emailsGenerating ?? 0} In Progress
                {(stats?.emailsGenerationRetryPending ?? 0) > 0 ? ` • ${stats?.emailsGenerationRetryPending} Retry Pending` : ''}
                {(stats?.emailsGenerationFailed ?? 0) > 0 ? ` • ${stats?.emailsGenerationFailed} Failed` : ''}
              </span>
            </div>
            {stats?.geminiTelemetry && (
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
                <span>Model: <code className="font-mono font-medium text-foreground">{stats.geminiTelemetry.currentModel}</code></span>
                <span>In-Flight: <code className="font-mono text-foreground">{stats.geminiTelemetry.inFlightRequests}/{stats.geminiTelemetry.maxConcurrency}</code></span>
                {stats.geminiTelemetry.recent429Count > 0 ? (
                  <span className="text-amber-600 font-medium">429 Rate Limits: {stats.geminiTelemetry.recent429Count}</span>
                ) : null}
              </div>
            )}
          </div>
        </CardContent>
      </Card>


      {/* Stat Cards Grid */}
      <div className="grid gap-3.5 sm:gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
        <StatCard
          title="Total Companies"
          value={stats ? stats.totalCompanies : 0}
          icon={Building2}
          onClick={() => handleOpenCardView('total-companies')}
          active={activeModalView === 'total-companies'}
        />
        <StatCard
          title="Relevant Tech"
          value={stats ? stats.relevantCompanies : 0}
          icon={CheckCircle2}
          onClick={() => handleOpenCardView('relevant-tech')}
          active={activeModalView === 'relevant-tech'}
        />
        <StatCard
          title="Contacts Found"
          value={stats ? stats.totalContacts : 0}
          icon={Inbox}
          onClick={() => handleOpenCardView('contacts-found')}
          active={activeModalView === 'contacts-found'}
        />
        <StatCard
          title="Eligible Queued"
          value={stats ? stats.emailsQueued : 0}
          icon={Clock}
          onClick={() => handleOpenCardView('eligible-queued')}
          active={activeModalView === 'eligible-queued'}
        />
        <StatCard
          title="Emails Generated"
          value={stats ? stats.emailsGenerated : 0}
          icon={Sparkles}
          onClick={() => handleOpenCardView('emails-generated')}
          active={activeModalView === 'emails-generated'}
        />
        <StatCard
          title={stats?.isDryRun ? "Simulated Sends" : "Emails Sent"}
          value={stats ? (stats.isDryRun ? stats.emailsSimulated : stats.emailsSent) : 0}
          subtitle={stats?.isDryRun ? "Simulated — no real emails sent." : "30 successful real emails/day"}
          icon={Send}
          onClick={() => handleOpenCardView('emails-sent')}
          active={activeModalView === 'emails-sent'}
        />
        <StatCard
          title="Skipped / Filtered"
          value={stats ? stats.emailsSkipped : 0}
          icon={AlertCircle}
          onClick={() => handleOpenCardView('skipped-filtered')}
          active={activeModalView === 'skipped-filtered'}
        />
      </div>

      {/* Two-column layout for recent batches and activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Batches */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Recent Batches</CardTitle>
            <Link href="/batches" className="text-xs text-primary hover:underline">
              View All
            </Link>
          </CardHeader>
          <CardContent>
            {recentBatches.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Layers className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground">
                  No batches uploaded yet. Upload a CSV or PDF file to start outreach.
                </p>
                <Link href="/upload" className="mt-3">
                  <Button size="sm" variant="outline">
                    <Upload className="h-3.5 w-3.5" />
                    Upload Contacts
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {recentBatches.map((b) => (
                  <div key={b.id} className="py-3 flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-foreground">{b.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.totalRecords} records • {b.emailsPending} pending • {formatDateTime(b.uploadDate)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={b.status === 'completed' ? 'success' : b.status === 'queued' ? 'default' : 'secondary'}>
                        {b.status}
                      </Badge>
                      <Link href={`/batches/${b.id}`}>
                        <Button variant="ghost" size="sm">
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* System Pipeline Status */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">System Pipeline Readiness</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between text-xs pb-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium text-foreground">File Ingestion & Normalization</span>
                </div>
                <Badge variant="success">Operational</Badge>
              </div>
              <div className="flex items-center justify-between text-xs pb-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium text-foreground">AI Company Relevance Classifier</span>
                </div>
                <Badge variant="success">Operational</Badge>
              </div>
              <div className="flex items-center justify-between text-xs pb-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium text-foreground">Resume Intelligence & Profiling</span>
                </div>
                <Badge variant="success">Operational</Badge>
              </div>
              <div className="flex items-center justify-between text-xs pb-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium text-foreground">AI Email Personalization (Phase 3)</span>
                </div>
                <Badge variant="success">Operational</Badge>
              </div>
              <div className="flex items-center justify-between text-xs pb-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium text-foreground">Gmail OAuth & Encryption Engine (Phase 4)</span>
                </div>
                <Badge variant="success">Operational</Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-medium text-foreground">Persistent Queue Worker & Scheduler (Phase 5)</span>
                </div>
                <Badge variant="success">Operational</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Interactive Detail Modal for Dashboard Statistics */}
      {activeModalView && (
        <DashboardDetailModal
          view={activeModalView}
          onClose={handleCloseCardView}
          isDryRun={Boolean(stats?.isDryRun)}
        />
      )}
    </div>
  );
}
