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
  Award,
  Briefcase,
  ChevronDown,
  ChevronUp,
  Link as LinkIcon,
  Save,
  Layers,
  Sparkles,
  ExternalLink,
  Download,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import type { ResumeData, StructuredResumeProfile, SchedulerConfig, VerifiedProfileLinks } from '@/types';

export default function SettingsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [resumeData, setResumeData] = useState<ResumeData | null>(null);
  const [profile, setProfile] = useState<StructuredResumeProfile | null>(null);
  const [verifiedLinks, setVerifiedLinks] = useState<VerifiedProfileLinks>({
    linkedin: '',
    github: '',
    portfolio: '',
    other: '',
  });
  const [savingLinks, setSavingLinks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reanalyzing, setReanalyzing] = useState(false);

  const handleReparseResume = async () => {
    setReanalyzing(true);
    setErrorMessage(null);
    setStatusMessage('Re-analyzing stored original resume PDF with Direct Multimodal AI...');
    try {
      const res = await fetch('/api/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reparse' }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to re-analyze resume.');
      }
      setResumeData(json.data.resume);
      setProfile(json.data.profile);
      if (json.data.verifiedLinks) {
        setVerifiedLinks(json.data.verifiedLinks);
      }
      setStatusMessage('Resume PDF re-analyzed via Direct Multimodal AI and candidate profile updated successfully!');
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error re-analyzing resume.');
    } finally {
      setReanalyzing(false);
    }
  };

  const handleSaveLinks = async () => {
    setSavingLinks(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/resume/links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verifiedLinks),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to save verified profile links.');
      }
      setVerifiedLinks(json.data);
      setStatusMessage('Verified profile links saved successfully!');
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error saving verified links.');
    } finally {
      setSavingLinks(false);
    }
  };

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
            if (resumeJson.data.verifiedLinks) {
              setVerifiedLinks(resumeJson.data.verifiedLinks);
            }
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
      if (json.data.verifiedLinks) {
        setVerifiedLinks(json.data.verifiedLinks);
      }
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
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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
            <div className="flex items-center gap-2">
              {resumeData ? (
                <>
                  <Badge variant="success">Active Profile</Badge>
                  <Badge variant="secondary" className="border-emerald-200 bg-emerald-50 text-emerald-700 text-xs">
                    Extraction Complete (Verified)
                  </Badge>
                </>
              ) : (
                <Badge variant="warning">No Resume Uploaded</Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">Loading profile...</div>
          ) : uploading ? (
            <div className="flex flex-col items-center justify-center py-10 text-center space-y-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-xs font-medium text-primary">{statusMessage || 'Processing resume...'}</p>
            </div>
          ) : resumeData && profile ? (
            <div className="space-y-6">
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleReparseResume}
                    disabled={reanalyzing || uploading}
                    className="gap-1.5"
                  >
                    {reanalyzing ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Re-analyzing with AI...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        Re-analyze Resume with AI
                      </>
                    )}
                  </Button>
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

              {/* Extraction Counts Bar */}
              {(() => {
                const languages = profile.skills?.languages || [];
                const frontend = profile.skills?.frontend || profile.skills?.webTechnologies || [];
                const backend = profile.skills?.backend || profile.skills?.backendTechnologies || [];
                const frameworks = profile.skills?.frameworks || [];
                const databases = profile.skills?.databases || [];
                const aiMl = profile.skills?.aiMl || [];
                const dataScience = profile.skills?.dataScience || [];
                const cloudDevOps = profile.skills?.cloudDevOps || [];
                const tools = profile.skills?.tools || profile.skills?.developerTools || [];
                const apisIntegrations = profile.skills?.apisIntegrations || [];
                const coreCs = profile.skills?.coreCs || profile.skills?.coreConcepts || [];
                const other = profile.skills?.other || [];

                const totalSkillsCount = [
                  ...languages,
                  ...frontend,
                  ...backend,
                  ...frameworks,
                  ...databases,
                  ...aiMl,
                  ...dataScience,
                  ...cloudDevOps,
                  ...tools,
                  ...apisIntegrations,
                  ...coreCs,
                  ...other,
                ].length;

                return (
                  <div className="rounded-lg border border-border/80 bg-slate-50/70 p-3">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-2">
                      <Layers className="h-3.5 w-3.5 text-primary" />
                      <span>Extracted Candidate Facts Summary</span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="rounded-md bg-white px-2.5 py-1 border border-border font-medium text-slate-700 shadow-xs">
                        Education: <strong className="text-primary font-bold">{profile.education?.length || 0}</strong>
                      </span>
                      <span className="rounded-md bg-white px-2.5 py-1 border border-border font-medium text-slate-700 shadow-xs">
                        Skills: <strong className="text-primary font-bold">{totalSkillsCount}</strong>
                      </span>
                      <span className="rounded-md bg-white px-2.5 py-1 border border-border font-medium text-slate-700 shadow-xs">
                        Experience: <strong className="text-primary font-bold">{profile.experience?.length || 0}</strong>
                      </span>
                      <span className="rounded-md bg-white px-2.5 py-1 border border-border font-medium text-slate-700 shadow-xs">
                        Projects: <strong className="text-primary font-bold">{profile.projects?.length || 0}</strong>
                      </span>
                      <span className="rounded-md bg-white px-2.5 py-1 border border-border font-medium text-slate-700 shadow-xs">
                        Certifications: <strong className="text-primary font-bold">{profile.certifications?.length || 0}</strong>
                      </span>
                      <span className="rounded-md bg-white px-2.5 py-1 border border-border font-medium text-slate-700 shadow-xs">
                        Achievements: <strong className="text-primary font-bold">{profile.achievements?.length || 0}</strong>
                      </span>
                      <span className="rounded-md bg-white px-2.5 py-1 border border-border font-medium text-slate-700 shadow-xs">
                        Leadership: <strong className="text-primary font-bold">{profile.leadership?.length || 0}</strong>
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* User-Verified Profile Links Editor (Persisted separately from Resume PDF) */}
              <div className="rounded-xl border border-blue-200 bg-blue-50/30 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="rounded-md bg-blue-100 p-1.5 text-blue-700">
                      <LinkIcon className="h-4 w-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                        User-Verified Professional Links
                      </h4>
                      <p className="text-[11px] text-muted-foreground">
                        Maintained separately from your resume PDF. Safely referenced in outreach emails and signatures.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={handleSaveLinks}
                    disabled={savingLinks}
                    className="gap-1.5 text-xs shrink-0"
                  >
                    {savingLinks ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save Verified Links
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 pt-1">
                  <div>
                    <label className="text-[11px] font-semibold text-slate-700 block mb-1">LinkedIn Profile</label>
                    <input
                      type="url"
                      value={verifiedLinks.linkedin || ''}
                      onChange={(e) => setVerifiedLinks({ ...verifiedLinks, linkedin: e.target.value })}
                      placeholder="https://linkedin.com/in/username"
                      className="h-8 w-full rounded-md border border-border bg-white px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-slate-700 block mb-1">GitHub Profile</label>
                    <input
                      type="url"
                      value={verifiedLinks.github || ''}
                      onChange={(e) => setVerifiedLinks({ ...verifiedLinks, github: e.target.value })}
                      placeholder="https://github.com/username"
                      className="h-8 w-full rounded-md border border-border bg-white px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-slate-700 block mb-1">Portfolio / Personal Website</label>
                    <input
                      type="url"
                      value={verifiedLinks.portfolio || ''}
                      onChange={(e) => setVerifiedLinks({ ...verifiedLinks, portfolio: e.target.value })}
                      placeholder="https://yourportfolio.dev"
                      className="h-8 w-full rounded-md border border-border bg-white px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-slate-700 block mb-1">Other Professional Link</label>
                    <input
                      type="url"
                      value={verifiedLinks.other || ''}
                      onChange={(e) => setVerifiedLinks({ ...verifiedLinks, other: e.target.value })}
                      placeholder="https://leetcode.com/username or blog"
                      className="h-8 w-full rounded-md border border-border bg-white px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </div>
              </div>

              {/* Profile Details & Summary */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-border pb-3 gap-2">
                  <div>
                    <h3 className="text-lg font-bold text-foreground">{profile.name}</h3>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      {profile.email && <span>{profile.email}</span>}
                      {profile.phone && <span>• {profile.phone}</span>}
                      {profile.location && <span>• {profile.location}</span>}
                    </div>
                    {profile.summary && (
                      <p className="text-xs text-slate-600 mt-2 leading-relaxed">{profile.summary}</p>
                    )}
                  </div>
                </div>

                {/* Education Section */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                    <div className="flex items-center gap-1.5">
                      <GraduationCap className="h-4 w-4 text-primary" />
                      <span>Education ({profile.education?.length || 0})</span>
                    </div>
                  </div>
                  {profile.education && profile.education.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {profile.education.map((edu, idx) => (
                        <div key={idx} className="rounded-lg border border-border/80 bg-muted/10 p-3 text-xs space-y-1">
                          <p className="font-semibold text-foreground">{edu.degree}</p>
                          <p className="text-muted-foreground">{edu.institution}</p>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground pt-0.5">
                            {edu.year && <span>{edu.year}</span>}
                            {edu.score && <span className="font-medium text-slate-700">• Grade: {edu.score}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/80 bg-muted/5 p-3 text-center">
                      <p className="text-xs font-medium text-muted-foreground">Education — 0 extracted</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        No education records found in structured profile. Click &ldquo;Re-analyze Resume with AI&rdquo; to re-structure.
                      </p>
                    </div>
                  )}
                </div>

                {/* Categorized Skills Section */}
                {(() => {
                  const languages = profile.skills?.languages || [];
                  const frontend = profile.skills?.frontend || profile.skills?.webTechnologies || [];
                  const backend = profile.skills?.backend || profile.skills?.backendTechnologies || [];
                  const frameworks = profile.skills?.frameworks || [];
                  const databases = profile.skills?.databases || [];
                  const aiMl = profile.skills?.aiMl || [];
                  const dataScience = profile.skills?.dataScience || [];
                  const cloudDevOps = profile.skills?.cloudDevOps || [];
                  const tools = profile.skills?.tools || profile.skills?.developerTools || [];
                  const apisIntegrations = profile.skills?.apisIntegrations || [];
                  const coreCs = profile.skills?.coreCs || profile.skills?.coreConcepts || [];
                  const other = profile.skills?.other || [];

                  const totalCount = [
                    ...languages,
                    ...frontend,
                    ...backend,
                    ...frameworks,
                    ...databases,
                    ...aiMl,
                    ...dataScience,
                    ...cloudDevOps,
                    ...tools,
                    ...apisIntegrations,
                    ...coreCs,
                    ...other,
                  ].length;

                  return (
                    <div className="space-y-3 pt-2 border-t border-border">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <Code2 className="h-4 w-4 text-primary" />
                        <span>Categorized Technical Skills ({totalCount})</span>
                      </div>

                      {totalCount > 0 ? (
                        <div className="grid gap-2.5 sm:grid-cols-2 text-xs">
                          {languages.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Programming Languages</span>
                              <div className="flex flex-wrap gap-1">
                                {languages.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {frontend.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Frontend & Web</span>
                              <div className="flex flex-wrap gap-1">
                                {frontend.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {backend.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Backend & Servers</span>
                              <div className="flex flex-wrap gap-1">
                                {backend.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {frameworks.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Frameworks & Libraries</span>
                              <div className="flex flex-wrap gap-1">
                                {frameworks.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {databases.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Databases & Storage</span>
                              <div className="flex flex-wrap gap-1">
                                {databases.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {aiMl.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">AI & Machine Learning</span>
                              <div className="flex flex-wrap gap-1">
                                {aiMl.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {dataScience.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Data Science & Analytics</span>
                              <div className="flex flex-wrap gap-1">
                                {dataScience.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {cloudDevOps.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Cloud & DevOps</span>
                              <div className="flex flex-wrap gap-1">
                                {cloudDevOps.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {tools.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Developer Tools & VCS</span>
                              <div className="flex flex-wrap gap-1">
                                {tools.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {apisIntegrations.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">APIs & Integrations</span>
                              <div className="flex flex-wrap gap-1">
                                {apisIntegrations.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {coreCs.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Core Computer Science</span>
                              <div className="flex flex-wrap gap-1">
                                {coreCs.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {other.length > 0 && (
                            <div className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">Other Skills</span>
                              <div className="flex flex-wrap gap-1">
                                {other.map((s) => (
                                  <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/80 bg-muted/5 p-3 text-center">
                          <p className="text-xs font-medium text-muted-foreground">Skills — 0 extracted</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            No technical skills categorized. Click &ldquo;Re-analyze Resume with AI&rdquo; to re-structure.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Experience Section */}
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Briefcase className="h-4 w-4 text-primary" />
                    <span>Experience ({profile.experience?.length || 0})</span>
                  </div>
                  {profile.experience && profile.experience.length > 0 ? (
                    <div className="space-y-3">
                      {profile.experience.map((exp, idx) => (
                        <div key={idx} className="rounded-lg border border-border/80 bg-muted/10 p-3 text-xs space-y-2">
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                            <div>
                              <p className="font-bold text-foreground">{exp.title}</p>
                              <p className="text-muted-foreground">{exp.company}{exp.location ? ` • ${exp.location}` : ''}</p>
                            </div>
                            <span className="text-[11px] text-muted-foreground font-mono">
                              {exp.startDate || ''} – {exp.endDate || 'Present'}
                            </span>
                          </div>
                          {exp.bullets && exp.bullets.length > 0 && (
                            <ul className="list-disc list-inside space-y-1 text-slate-700 text-[11px]">
                              {exp.bullets.map((bullet, bIdx) => (
                                <li key={bIdx} className="leading-relaxed">{bullet}</li>
                              ))}
                            </ul>
                          )}
                          {exp.technologies && exp.technologies.length > 0 && (
                            <div className="flex flex-wrap gap-1 pt-1">
                              {exp.technologies.map((t) => (
                                <span key={t} className="text-[10px] text-slate-600 bg-white border border-border px-1.5 py-0.5 rounded">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/80 bg-muted/5 p-3 text-center">
                      <p className="text-xs font-medium text-muted-foreground">Experience — 0 extracted</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        No work experience or internships extracted. If your resume contains experience, click &ldquo;Re-analyze Resume with AI&rdquo; above.
                      </p>
                    </div>
                  )}
                </div>

                {/* Projects Section */}
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <FolderGit2 className="h-4 w-4 text-primary" />
                    <span>Technical Projects ({profile.projects?.length || 0})</span>
                  </div>
                  {profile.projects && profile.projects.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {profile.projects.map((p, idx) => (
                        <div key={idx} className="rounded-lg border border-border/80 bg-muted/10 p-3 text-xs space-y-2 flex flex-col justify-between">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-1">
                              <p className="font-bold text-foreground">{p.title}</p>
                              <div className="flex items-center gap-1.5">
                                {p.liveUrl && (
                                  <a href={p.liveUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-[10px] flex items-center gap-0.5">
                                    Demo
                                  </a>
                                )}
                                {p.githubUrl && (
                                  <a href={p.githubUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-[10px] flex items-center gap-0.5">
                                    Code
                                  </a>
                                )}
                              </div>
                            </div>
                            {p.description && (
                              <p className="text-[11px] text-slate-700 leading-relaxed">{p.description}</p>
                            )}
                            {p.highlights && p.highlights.length > 0 && (
                              <ul className="list-disc list-inside space-y-0.5 text-slate-600 text-[11px] pt-1">
                                {p.highlights.map((h, hIdx) => (
                                  <li key={hIdx}>{h}</li>
                                ))}
                              </ul>
                            )}
                            {p.metrics && p.metrics.length > 0 && (
                              <div className="pt-1">
                                {p.metrics.map((m, mIdx) => (
                                  <span key={mIdx} className="inline-block text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 mr-1 mb-1">
                                    {m}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1 pt-2 border-t border-border/40">
                            {p.techStack.map((t) => (
                              <span key={t} className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/80 bg-muted/5 p-3 text-center">
                      <p className="text-xs font-medium text-muted-foreground">Projects — 0 extracted</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        No technical projects extracted. If your resume contains projects, click &ldquo;Re-analyze Resume with AI&rdquo; above.
                      </p>
                    </div>
                  )}
                </div>

                {/* Achievements & Certifications */}
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Award className="h-4 w-4 text-primary" />
                    <span>Achievements & Certifications ({(profile.achievements?.length || 0) + (profile.certifications?.length || 0)})</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 text-xs">
                    <div className="rounded-lg border border-border/60 bg-muted/5 p-3 space-y-1.5">
                      <p className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">
                        Key Achievements ({profile.achievements?.length || 0})
                      </p>
                      {profile.achievements && profile.achievements.length > 0 ? (
                        <ul className="list-disc list-inside space-y-1 text-slate-700 text-[11px]">
                          {profile.achievements.map((ach, idx) => (
                            <li key={idx}>
                              {typeof ach === 'string' ? ach : (
                                <>
                                  <strong>{ach.title}</strong>
                                  {ach.description ? ` — ${ach.description}` : ''}
                                  {(ach.date || ach.year) ? ` (${ach.date || ach.year})` : ''}
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-muted-foreground italic">No achievements or competition awards extracted.</p>
                      )}
                    </div>

                    <div className="rounded-lg border border-border/60 bg-muted/5 p-3 space-y-1.5">
                      <p className="text-[11px] font-bold text-slate-700 uppercase tracking-wide">
                        Certifications ({profile.certifications?.length || 0})
                      </p>
                      {profile.certifications && profile.certifications.length > 0 ? (
                        <ul className="list-disc list-inside space-y-1 text-slate-700 text-[11px]">
                          {profile.certifications.map((cert, idx) => (
                            <li key={idx}>
                              {typeof cert === 'string' ? cert : (
                                <>
                                  <strong>{cert.name}</strong>
                                  {cert.issuer ? ` (${cert.issuer})` : ''}
                                  {(cert.date || cert.year) ? ` [${cert.date || cert.year}]` : ''}
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-muted-foreground italic">No certifications extracted from resume.</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Leadership & Extra-Curricular */}
                <div className="space-y-2 pt-2 border-t border-border">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Sparkles className="h-4 w-4 text-primary" />
                    <span>Leadership & Extra-Curricular ({profile.leadership?.length || 0})</span>
                  </div>
                  {profile.leadership && profile.leadership.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2 text-xs">
                      {profile.leadership.map((lead, idx) => (
                        <div key={idx} className="rounded-lg border border-border/60 bg-muted/5 p-2.5 space-y-1">
                          <p className="font-semibold text-foreground">{lead.position || lead.role || 'Coordinator'}</p>
                          <p className="text-muted-foreground">{lead.organization}{lead.duration || lead.period ? ` • ${lead.duration || lead.period}` : ''}</p>
                          {(lead.description || lead.highlights?.[0]) && (
                            <p className="text-[11px] text-slate-600 leading-relaxed">{lead.description || lead.highlights?.[0]}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/80 bg-muted/5 p-3 text-center">
                      <p className="text-xs font-medium text-muted-foreground">Leadership — 0 extracted</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        No positions of responsibility extracted.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Source Resume Document Card (Direct Multimodal AI) */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-blue-50 p-2.5 text-blue-600">
                      <FileText className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                          Source Resume Document
                        </h4>
                        <Badge variant="secondary" className="border-blue-200 bg-blue-50 text-blue-700 text-[10px] font-semibold gap-1">
                          <Sparkles className="h-3 w-3 text-blue-600" />
                          Analyzed via Direct Multimodal AI
                        </Badge>
                      </div>
                      <p className="text-xs text-foreground font-medium mt-0.5">
                        {resumeData.filename}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Uploaded: {formatDateTime(resumeData.uploadedAt)}
                        {resumeData.version && (
                          <span className="font-mono ml-2">(v: {resumeData.version.slice(0, 19)})</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href="/api/resume/file"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex"
                    >
                      <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                        <ExternalLink className="h-3.5 w-3.5" />
                        Preview PDF
                      </Button>
                    </a>
                    <a
                      href="/api/resume/file?download=true"
                      download
                      className="inline-flex"
                    >
                      <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                        <Download className="h-3.5 w-3.5" />
                        Download PDF
                      </Button>
                    </a>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border py-8 px-4 text-center">
              <Upload className="h-6 w-6 text-muted-foreground mb-2" />
              <p className="text-sm font-medium text-foreground">Upload your resume</p>
              <p className="text-xs text-muted-foreground max-w-sm mt-1">
                Upload a PDF resume. The AI will extract your verified skills, projects, and background to power genuine,
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
