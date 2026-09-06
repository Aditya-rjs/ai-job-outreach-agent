'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Mail,
  FileText,
  Clock,
  Shield,
  Pause,
  Play,
  Square,
  Globe,
  Upload,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Code2,
  FolderGit2,
  GraduationCap,
  Send,
  Unlink,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import type { ResumeData, StructuredResumeProfile, SchedulerConfig } from '@/types';

export default function SettingsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [resumeData, setResumeData] = useState<ResumeData | null>(null);
  const [profile, setProfile] = useState<StructuredResumeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Gmail states
  const [gmailStatus, setGmailStatus] = useState<{ connected: boolean; email: string | null }>({
    connected: false,
    email: null,
  });
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [testRecipient, setTestRecipient] = useState('');
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; messageId?: string } | null>(null);

  // Scheduler states
  const [scheduler, setScheduler] = useState<SchedulerConfig | null>(null);
  const [schedulerActionLoading, setSchedulerActionLoading] = useState(false);

  const handlePauseScheduler = async () => {
    setSchedulerActionLoading(true);
    try {
      const res = await fetch('/api/scheduler/pause', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setScheduler(json.data);
        setStatusMessage('Outreach scheduler paused.');
        setTimeout(() => setStatusMessage(null), 4000);
      }
    } finally {
      setSchedulerActionLoading(false);
    }
  };

  const handleResumeScheduler = async () => {
    setSchedulerActionLoading(true);
    try {
      const res = await fetch('/api/scheduler/resume', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setScheduler(json.data);
        setStatusMessage('Outreach scheduler resumed.');
        setTimeout(() => setStatusMessage(null), 4000);
      }
    } finally {
      setSchedulerActionLoading(false);
    }
  };

  const handleStopScheduler = async () => {
    if (!confirm('Stop outreach campaign? Progress will be preserved.')) return;
    setSchedulerActionLoading(true);
    try {
      const res = await fetch('/api/scheduler/stop', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setScheduler(json.data);
        setStatusMessage('Outreach campaign stopped.');
        setTimeout(() => setStatusMessage(null), 4000);
      }
    } finally {
      setSchedulerActionLoading(false);
    }
  };

  useEffect(() => {
    let ignore = false;

    // Check URL search params for OAuth redirect results
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const gmailParam = params.get('gmail');
      const errorParam = params.get('error');

      if (gmailParam === 'connected') {
        window.history.replaceState({}, '', '/settings');
        setTimeout(() => {
          if (!ignore) setStatusMessage('Gmail connected and verified successfully! You can now send integration tests.');
        }, 0);
      } else if (errorParam) {
        window.history.replaceState({}, '', '/settings');
        setTimeout(() => {
          if (!ignore) setErrorMessage(decodeURIComponent(errorParam || 'Gmail authorization failed.'));
        }, 0);
      }
    }
    Promise.all([
      fetch('/api/resume').then((res) => res.json()),
      fetch('/api/gmail/status').then((res) => res.json()),
      fetch('/api/scheduler/status').then((res) => res.json()),
    ])
      .then(([resumeJson, gmailJson, schedulerJson]) => {
        if (!ignore) {
          if (resumeJson.success) {
            setResumeData(resumeJson.data.resume);
            setProfile(resumeJson.data.profile);
          }
          if (gmailJson.success) {
            setGmailStatus(gmailJson.data);
            if (gmailJson.data.email && gmailJson.data.email !== 'Authorized Account') {
              setTestRecipient(gmailJson.data.email);
            }
          }
          if (schedulerJson.success) {
            setScheduler(schedulerJson.data);
          }
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load settings data:', err);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [refreshKey]);

  const handleResumeFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];

    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    if (ext !== '.pdf') {
      setErrorMessage('Please select a PDF document.');
      return;
    }

    setUploading(true);
    setErrorMessage(null);
    setStatusMessage('Uploading and extracting resume text...');

    try {
      const formData = new FormData();
      formData.append('file', file);

      setStatusMessage('Analyzing and structuring candidate profile with AI...');
      const res = await fetch('/api/resume', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to parse resume.');
      }

      setResumeData(json.data.resume);
      setProfile(json.data.profile);
      setStatusMessage('Resume parsed and candidate profile verified successfully!');
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error processing resume.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDisconnectGmail = async () => {
    if (!confirm('Are you sure you want to disconnect your Gmail account? Outreach data and generated emails will be preserved.')) {
      return;
    }

    setIsDisconnecting(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/gmail/disconnect', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to disconnect Gmail.');
      }

      setGmailStatus({ connected: false, email: null });
      setStatusMessage('Gmail disconnected successfully.');
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error disconnecting Gmail.');
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!testRecipient || !testRecipient.includes('@')) {
      setErrorMessage('Please enter a valid recipient email for the test send.');
      return;
    }

    setIsSendingTest(true);
    setTestResult(null);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/gmail/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: testRecipient }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Test send failed.');
      }

      setTestResult({
        success: true,
        message: `Test email successfully dispatched to ${json.data.recipient}!`,
        messageId: json.data.messageId,
      });
    } catch (err: unknown) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : 'Test email failed.',
      });
    } finally {
      setIsSendingTest(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Settings</h2>
        <p className="text-sm text-muted-foreground">
          Configure your professional profile, Gmail authorization, and outreach parameters
        </p>
      </div>

      {statusMessage && (
        <div className="flex items-center gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3.5 text-xs font-medium text-emerald-800">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div className="flex items-center gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3.5 text-xs font-medium text-red-800">
          <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={handleResumeFileSelected}
      />

      {/* Gmail Connection (Phase 4) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-red-50 p-2">
                <Mail className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <CardTitle>Gmail Connection</CardTitle>
                <CardDescription>
                  Connect your Google account via OAuth 2.0 to send verified outreach emails with resume attachments.
                </CardDescription>
              </div>
            </div>
            {gmailStatus.connected ? (
              <Badge variant="success">Connected</Badge>
            ) : (
              <Badge variant="warning">Not Connected</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {gmailStatus.connected ? (
            <div className="space-y-4">
              {/* Connected Account Card */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-emerald-100 p-2 text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-emerald-950">
                      Authorized Account: {gmailStatus.email || 'Google Workspace / Gmail'}
                    </p>
                    <p className="text-[11px] text-emerald-700 mt-0.5">
                      OAuth 2.0 active with minimal scope (<code className="font-mono text-[10px]">gmail.send</code>).
                      Credentials encrypted with AES-256-GCM.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnectGmail}
                  disabled={isDisconnecting}
                  className="text-destructive border-destructive/30 hover:bg-destructive/10 gap-1.5 shrink-0"
                >
                  {isDisconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
                  Disconnect
                </Button>
              </div>

              {/* Test Send Section */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">Send Test Email</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Verify Gmail delivery and resume attachment. Test messages do not count towards daily quota
                    and are not recorded in recruiter outreach history.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-2.5 items-center">
                  <input
                    type="email"
                    value={testRecipient}
                    onChange={(e) => setTestRecipient(e.target.value)}
                    placeholder="Enter test recipient email..."
                    className="h-9 w-full sm:w-80 rounded-lg border border-border bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <Button
                    size="sm"
                    onClick={handleSendTestEmail}
                    disabled={isSendingTest}
                    className="w-full sm:w-auto gap-1.5"
                  >
                    {isSendingTest ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Sending Test...
                      </>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        Send Test Email
                      </>
                    )}
                  </Button>
                </div>

                {testResult && (
                  <div
                    className={`rounded-lg border p-3 text-xs flex items-start gap-2 ${
                      testResult.success
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        : 'border-red-200 bg-red-50 text-red-900'
                    }`}
                  >
                    {testResult.success ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="font-semibold">{testResult.message}</p>
                      {testResult.messageId && (
                        <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                          Gmail Message ID: {testResult.messageId}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
              <div className="flex gap-3">
                <AlertCircle className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-foreground">Gmail not connected</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Connect your Gmail account using Google OAuth 2.0. The application requests only the
                    minimal <code className="font-mono text-xs">gmail.send</code> scope. Your password is never stored
                    and tokens are encrypted server-side with AES-256-GCM.
                  </p>
                </div>
              </div>
              <div className="pt-1">
                <a href="/api/gmail/auth">
                  <Button className="gap-2">
                    <Mail className="h-4 w-4" />
                    Connect Gmail
                  </Button>
                </a>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Resume Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-blue-50 p-2">
                <FileText className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <CardTitle>Resume & Professional Profile</CardTitle>
                <CardDescription>
                  Your verified resume acts as the strict source of truth for email personalization and PDF attachment.
                </CardDescription>
              </div>
            </div>
            {resumeData ? (
              <Badge variant="success">Active Profile</Badge>
            ) : (
              <Badge variant="warning">No Resume Uploaded</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">Loading profile...</div>
          ) : uploading ? (
            <div className="flex flex-col items-center justify-center py-10 text-center space-y-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-xs font-medium text-primary">{statusMessage || 'Processing resume...'}</p>
            </div>
          ) : resumeData && profile ? (
            <div className="space-y-4">
              {/* File metadata row */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs">
                <div>
                  <span className="font-semibold text-foreground">{resumeData.filename}</span>
                  <span className="text-muted-foreground ml-2">
                    • Uploaded {formatDateTime(resumeData.uploadedAt)}
                  </span>
                  {resumeData.version && (
                    <span className="text-[11px] font-mono text-muted-foreground ml-2">
                      (v: {resumeData.version.slice(0, 19)})
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setLoading(true);
                      setRefreshKey((k) => k + 1);
                    }}
                    className="gap-1.5"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Replace Resume
                  </Button>
                </div>
              </div>

              {/* Profile Summary Card */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-border pb-3 gap-2">
                  <div>
                    <h3 className="text-base font-bold text-foreground">{profile.name}</h3>
                    <p className="text-xs text-muted-foreground">{profile.summary}</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GraduationCap className="h-4 w-4 text-primary" />
                    <span>
                      {profile.education[0]?.degree || 'Computer Science'} • {profile.education[0]?.institution || 'University'}
                    </span>
                  </div>
                </div>

                {/* Categorized Skills */}
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Code2 className="h-3.5 w-3.5 text-primary" />
                    <span>Verified Skills (Source of Truth)</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ...profile.skills.languages,
                      ...profile.skills.frameworks,
                      ...profile.skills.databases,
                      ...profile.skills.cloudDevOps,
                    ].map((skill) => (
                      <Badge key={skill} variant="secondary" className="text-[11px]">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Featured Projects */}
                {profile.projects && profile.projects.length > 0 && (
                  <div className="space-y-2 pt-1 border-t border-border">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <FolderGit2 className="h-3.5 w-3.5 text-primary" />
                      <span>Featured Projects</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {profile.projects.slice(0, 2).map((p) => (
                        <div key={p.title} className="rounded-lg border border-border/80 bg-muted/10 p-2.5 text-xs">
                          <p className="font-medium text-foreground">{p.title}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                            {p.description || p.highlights?.[0] || 'Technical software project.'}
                          </p>
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {p.techStack.slice(0, 3).map((t) => (
                              <span key={t} className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border py-8 px-4 text-center">
              <Upload className="h-6 w-6 text-muted-foreground mb-2" />
              <p className="text-sm font-medium text-foreground">Upload your resume</p>
              <p className="text-xs text-muted-foreground max-w-sm mt-1">
                Upload a PDF resume. The AI will extract your verified skills and background to power genuine,
                personalized outreach emails without hallucinations.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => fileInputRef.current?.click()}
              >
                Upload Resume (PDF)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sending Schedule */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-violet-50 p-2">
              <Clock className="h-5 w-5 text-violet-600" />
            </div>
            <div>
              <CardTitle>Sending Schedule</CardTitle>
              <CardDescription>Daily sending window: 10:00 AM–4:00 PM IST with 6-day contact cooldown</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Sending Window</p>
              <p className="text-2xl font-bold text-foreground mt-1">10 AM – 4 PM</p>
              <p className="text-xs text-muted-foreground">active sending hours (IST)</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Global Cooldown</p>
              <p className="text-2xl font-bold text-foreground mt-1">6 Days</p>
              <p className="text-xs text-muted-foreground">144 hrs per sent contact</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs font-medium text-muted-foreground">Interval</p>
              <p className="text-2xl font-bold text-foreground mt-1">3 min</p>
              <p className="text-xs text-muted-foreground">between emails</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">Timezone</p>
              </div>
              <p className="text-lg font-bold text-foreground mt-1">Asia/Kolkata</p>
              <p className="text-xs text-muted-foreground">IST (UTC+5:30)</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Schedule configuration will be active in Phase 5.
          </p>
        </CardContent>
      </Card>

      {/* Outreach Controls */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-50 p-2">
              <Shield className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <CardTitle>Outreach Control</CardTitle>
              <CardDescription>Pause, resume, or stop the outreach campaign</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {scheduler?.isPaused || scheduler?.isStopped ? (
              <Button onClick={handleResumeScheduler} disabled={schedulerActionLoading} className="gap-1.5">
                <Play className="h-4 w-4" />
                Resume Outreach
              </Button>
            ) : (
              <Button variant="outline" onClick={handlePauseScheduler} disabled={schedulerActionLoading} className="gap-1.5">
                <Pause className="h-4 w-4" />
                Pause Outreach
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={handleStopScheduler}
              disabled={schedulerActionLoading || scheduler?.isStopped}
              className="gap-1.5"
            >
              <Square className="h-4 w-4" />
              Stop Campaign
            </Button>
          </div>
          <div className="mt-3 text-xs text-muted-foreground flex items-center gap-2">
            <span>Current state:</span>
            {scheduler?.isStopped ? (
              <Badge variant="destructive">Stopped</Badge>
            ) : scheduler?.isPaused ? (
              <Badge variant="warning">Paused</Badge>
            ) : (
              <Badge variant="success">Active</Badge>
            )}
            {scheduler?.workerId && (
              <span className="font-mono text-[11px] text-muted-foreground ml-2">
                (Worker: {scheduler.workerId.slice(0, 16)})
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
