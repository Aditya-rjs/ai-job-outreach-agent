'use client';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import type { DashboardStats } from '@/types';
import { Cpu, AlertTriangle, CheckCircle2, ArrowRightLeft, ShieldAlert, Clock } from 'lucide-react';

interface AiProviderStatusProps {
  aiTelemetry?: DashboardStats['aiTelemetry'];
}

export function AiProviderStatus({ aiTelemetry }: AiProviderStatusProps) {
  const currentProvider = aiTelemetry?.currentActiveProvider || 'gemini';
  const isGeminiCooldownActive = Boolean(aiTelemetry?.geminiCooldownActive);
  const isOpenRouterCooldownActive = Boolean(aiTelemetry?.openRouterCooldownActive);
  const fallbackCount = aiTelemetry?.fallbackCount ?? 0;
  const gemini429Count = aiTelemetry?.gemini429Count ?? 0;
  const openRouterRequests = aiTelemetry?.openRouterDispatches ?? 0;
  const openRouterSuccesses = aiTelemetry?.openRouterSuccesses ?? 0;
  const openRouterFailures = aiTelemetry?.openRouterFailures ?? 0;
  const lastFallbackText = aiTelemetry?.lastFallbackAt ? formatDateTime(aiTelemetry.lastFallbackAt) : 'Never';
  const openRouterModel = aiTelemetry?.openRouterModel || 'openrouter/free';

  const isWaiting = currentProvider === 'waiting' || (isGeminiCooldownActive && isOpenRouterCooldownActive);
  const isOpenRouterActive = currentProvider === 'openrouter' && !isWaiting;

  return (
    <Card className="border-border/80 shadow-xs">
      <CardHeader className="pb-3 border-b border-border/60">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">AI Provider Status</CardTitle>
              <p className="text-xs text-muted-foreground">
                Autonomous dual-engine routing: Gemini primary with automatic OpenRouter fallback on rate limits
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isWaiting ? (
              <Badge variant="destructive" className="gap-1.5 animate-pulse bg-red-600 text-white">
                <Clock className="h-3 w-3" />
                Waiting (Both Providers In Cooldown)
              </Badge>
            ) : isOpenRouterActive ? (
              <Badge variant="warning" className="gap-1.5 animate-pulse">
                <AlertTriangle className="h-3 w-3" />
                OpenRouter Active (Gemini Cooldown)
              </Badge>
            ) : isGeminiCooldownActive ? (
              <Badge variant="warning" className="gap-1.5 animate-pulse">
                <AlertTriangle className="h-3 w-3" />
                Gemini Cooldown Active
              </Badge>
            ) : fallbackCount > 0 ? (
              <Badge variant="secondary" className="gap-1.5 text-amber-700 bg-amber-50 border-amber-200">
                <ArrowRightLeft className="h-3 w-3" />
                Fallback Previously Triggered
              </Badge>
            ) : (
              <Badge variant="success" className="gap-1.5">
                <CheckCircle2 className="h-3 w-3" />
                Gemini Healthy (Primary)
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-4 space-y-4">
        {/* Prominent Notification Banner based on state */}
        {isWaiting ? (
          <div className="rounded-xl border border-red-300 bg-red-50/90 p-3.5 text-xs text-red-950 flex items-start gap-3 shadow-xs">
            <div className="rounded-lg bg-red-200/80 p-1.5 text-red-900 shrink-0 mt-0.5">
              <Clock className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-red-950">WAITING: Both AI Providers Temporarily Rate-Limited</span>
                <Badge variant="destructive" className="text-[10px] uppercase font-bold py-0">Paused For Recovery</Badge>
              </div>
              <p className="text-red-900 mt-1">
                Gemini and OpenRouter both encountered HTTP 429 rate limits. Worker is safely pausing queue tasks to avoid burning contact attempts.
                The system will automatically resume as soon as either provider becomes available (OpenRouter fallback or Gemini primary).
              </p>
            </div>
          </div>
        ) : isOpenRouterActive ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50/90 p-3.5 text-xs text-amber-950 flex items-start gap-3 shadow-xs">
            <div className="rounded-lg bg-amber-200/80 p-1.5 text-amber-900 shrink-0 mt-0.5">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-amber-950">OPENROUTER ACTIVE: Handling AI Requests</span>
                <Badge variant="warning" className="text-[10px] uppercase font-bold py-0">Active Routing</Badge>
              </div>
              <p className="text-amber-900 mt-1">
                Gemini encountered an HTTP 429 rate limit. Requests are routing to{' '}
                <code className="font-mono font-semibold text-amber-950">{openRouterModel}</code>.
                {aiTelemetry?.geminiCooldownRemainingSeconds && aiTelemetry.geminiCooldownRemainingSeconds > 0
                  ? ` Gemini cooldown expires in ~${aiTelemetry.geminiCooldownRemainingSeconds}s, after which Gemini will automatically become primary again.`
                  : ' Gemini will automatically resume as primary once cooldown expires.'}
              </p>
            </div>
          </div>
        ) : fallbackCount > 0 ? (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs text-foreground flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-1.5 text-primary shrink-0 mt-0.5">
              <ArrowRightLeft className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-foreground">Rate Limit Fallback Recorded</span>
                <span className="text-[11px] text-muted-foreground">• Last fallback: {lastFallbackText}</span>
              </div>
              <p className="text-muted-foreground mt-0.5 text-[11px]">
                {fallbackCount} fallback event(s) have been successfully handled by OpenRouter ({openRouterModel}).
                Gemini cooldown has expired and Gemini has cleanly recovered as the primary provider.
              </p>
            </div>
          </div>
        ) : null}

        {/* Status Grid */}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-9">
          {/* 1. Primary Provider */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">Primary Provider</p>
            <p className="text-sm font-bold text-foreground">Gemini</p>
            <p className="text-[10px] text-muted-foreground font-mono truncate">
              {aiTelemetry?.geminiModelDisplay || 'ALLMODELS'}
            </p>
          </div>

          {/* 2. Current Active Provider */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">Current Active</p>
            <div className="flex items-center gap-1.5">
              <span
                className={`text-sm font-bold ${
                  isWaiting
                    ? 'text-red-600'
                    : isOpenRouterActive
                    ? 'text-amber-600'
                    : 'text-emerald-600'
                }`}
              >
                {isWaiting ? 'Waiting' : isOpenRouterActive ? 'OpenRouter' : 'Gemini'}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {isWaiting ? 'Both In Cooldown' : isOpenRouterActive ? 'Fallback Active' : 'Normal Primary'}
            </p>
          </div>

          {/* 3. Gemini 429 Count */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">Gemini 429 Count</p>
            <p className={`text-sm font-bold ${gemini429Count > 0 ? 'text-amber-600' : 'text-foreground'}`}>
              {gemini429Count}
            </p>
            <p className="text-[10px] text-muted-foreground">Rate limit responses</p>
          </div>

          {/* 4. Gemini Cooldown */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">Gemini Cooldown</p>
            <div className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${isGeminiCooldownActive ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
              <span className={`text-sm font-bold ${isGeminiCooldownActive ? 'text-amber-600' : 'text-foreground'}`}>
                {isGeminiCooldownActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground truncate">
              {isGeminiCooldownActive && aiTelemetry?.geminiCooldownRemainingSeconds
                ? `${aiTelemetry.geminiCooldownRemainingSeconds}s remaining`
                : 'Ready for traffic'}
            </p>
          </div>

          {/* 5. OpenRouter Requests */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">OpenRouter Requests</p>
            <p className="text-sm font-bold text-foreground">{openRouterRequests}</p>
            <p className="text-[10px] text-muted-foreground">Total fallback dispatches</p>
          </div>

          {/* 6. OpenRouter Successes */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">OpenRouter Successes</p>
            <p className="text-sm font-bold text-emerald-600">{openRouterSuccesses}</p>
            <p className="text-[10px] text-muted-foreground">Completed fallbacks</p>
          </div>

          {/* 7. OpenRouter Failures */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">OpenRouter Failures</p>
            <p className={`text-sm font-bold ${openRouterFailures > 0 ? 'text-red-600' : 'text-foreground'}`}>
              {openRouterFailures}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {isOpenRouterCooldownActive
                ? `Cooldown active (${aiTelemetry?.openRouterCooldownRemainingSeconds || 0}s)`
                : 'Fallback errors'}
            </p>
          </div>

          {/* 8. Fallbacks Triggered */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">Fallbacks Triggered</p>
            <p className={`text-sm font-bold ${fallbackCount > 0 ? 'text-amber-600' : 'text-foreground'}`}>
              {fallbackCount}
            </p>
            <p className="text-[10px] text-muted-foreground">Rate limit handoffs</p>
          </div>

          {/* 9. Last Fallback */}
          <div className="rounded-lg border border-border/70 bg-card p-3 space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">Last Fallback</p>
            <p className="text-xs font-semibold text-foreground truncate" title={lastFallbackText}>
              {lastFallbackText}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {aiTelemetry?.lastFallbackAt ? 'Recent 429 switch' : 'No fallbacks yet'}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
