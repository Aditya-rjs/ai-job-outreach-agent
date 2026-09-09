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
  Link as LinkIcon,
  Save,
  ExternalLink,
  Download,
  Plus,
  Trash2,
  Edit2,
  User,
  Phone,
  MapPin,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import type {
  ResumeData,
  CandidateProfile,
  CandidateEducation,
  CandidateExperience,
  CandidateProject,
  CandidateSkills,
  CandidateAchievement,
  SchedulerConfig,
} from '@/types';

export default function SettingsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Candidate Profile State
  const [profile, setProfile] = useState<CandidateProfile>({
    fullName: '',
    email: '',
    phone: '',
    degree: '',
    fieldOfStudy: '',
    institution: '',
    graduationYear: '',
    linkedin: '',
    github: '',
    portfolio: '',
    otherLink: '',
    education: [],
    experience: [],
    projects: [],
    skills: {
      languages: [],
      frameworks: [],
      databases: [],
      cloudDevOps: [],
      tools: [],
      other: [],
    },
    achievements: [],
    version: '1',
    updatedAt: '',
  });

  // Local form state for Personal Details
  const [personalForm, setPersonalForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    degree: '',
    fieldOfStudy: '',
    institution: '',
    graduationYear: '',
  });

  // Local form state for Links
  const [linksForm, setLinksForm] = useState({
    linkedin: '',
    github: '',
    portfolio: '',
    otherLink: '',
  });

  // Skills local state
  const [skillsState, setSkillsState] = useState<CandidateSkills>({
    languages: [],
    frameworks: [],
    databases: [],
    cloudDevOps: [],
    tools: [],
    other: [],
  });
  const [newSkillInput, setNewSkillInput] = useState<{ [key: string]: string }>({});

  // Modals for CRUD
  const [activeModal, setActiveModal] = useState<
    'education' | 'experience' | 'project' | 'achievement' | null
  >(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Sub-entity Form States
  const [eduForm, setEduForm] = useState<Partial<CandidateEducation>>({
    institution: '',
    degree: '',
    fieldOfStudy: '',
    year: '',
    gpa: '',
    highlights: [],
  });
  const [eduHighlightsText, setEduHighlightsText] = useState('');

  const [expForm, setExpForm] = useState<Partial<CandidateExperience>>({
    company: '',
    role: '',
    duration: '',
    location: '',
    highlights: [],
    technologies: [],
  });
  const [expHighlightsText, setExpHighlightsText] = useState('');
  const [expTechText, setExpTechText] = useState('');

  const [projForm, setProjForm] = useState<Partial<CandidateProject>>({
    name: '',
    duration: '',
    description: '',
    techStack: [],
    highlights: [],
    liveUrl: '',
    githubUrl: '',
  });
  const [projTechText, setProjTechText] = useState('');
  const [projHighlightsText, setProjHighlightsText] = useState('');

  const [achForm, setAchForm] = useState<Partial<CandidateAchievement>>({
    title: '',
    description: '',
    year: '',
  });

  // Resume attachment state
  const [resumeData, setResumeData] = useState<ResumeData | null>(null);
  const [uploadingResume, setUploadingResume] = useState(false);

  // Global status / error
  const [loading, setLoading] = useState(true);
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [savingLinks, setSavingLinks] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  // Load everything on mount
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
          if (!ignore) setStatusMessage('Gmail connected and verified successfully!');
        }, 0);
      } else if (errorParam) {
        window.history.replaceState({}, '', '/settings');
        setTimeout(() => {
          if (!ignore) setErrorMessage(decodeURIComponent(errorParam || 'Gmail authorization failed.'));
        }, 0);
      }
    }

    Promise.all([
      fetch('/api/candidate-profile').then((r) => r.json()),
      fetch('/api/resume').then((r) => r.json()),
      fetch('/api/gmail/status').then((r) => r.json()),
      fetch('/api/scheduler/status').then((r) => r.json()),
    ])
      .then(([profileJson, resumeJson, gmailJson, schedulerJson]) => {
        if (!ignore) {
          if (profileJson.success && profileJson.data) {
            const p: CandidateProfile = profileJson.data;
            setProfile(p);
            setPersonalForm({
              fullName: p.fullName || '',
              email: p.email || '',
              phone: p.phone || '',
              degree: p.degree || '',
              fieldOfStudy: p.fieldOfStudy || '',
              institution: p.institution || '',
              graduationYear: p.graduationYear || '',
            });
            setLinksForm({
              linkedin: p.linkedin || '',
              github: p.github || '',
              portfolio: p.portfolio || '',
              otherLink: p.otherLink || '',
            });
            setSkillsState(p.skills || {
              languages: [],
              frameworks: [],
              databases: [],
              cloudDevOps: [],
              tools: [],
              other: [],
            });
          }

          if (resumeJson.success && resumeJson.data) {
            setResumeData(resumeJson.data.resume);
          }

          if (gmailJson.success) {
            setGmailStatus({
              connected: gmailJson.data.connected,
              email: gmailJson.data.email,
            });
          }

          if (schedulerJson.success) {
            setScheduler(schedulerJson.data);
          }

          setLoading(false);
        }
      })
      .catch((err) => {
        if (!ignore) {
          console.error('Settings initialization failed:', err);
          setErrorMessage('Failed to load settings data. Please refresh.');
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  // Save Candidate Profile Helper (Direct to SQLite, ZERO AI)
  const saveProfileUpdates = async (updates: Partial<CandidateProfile>, successMsg?: string) => {
    setErrorMessage(null);
    try {
      const res = await fetch('/api/candidate-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to save candidate profile.');
      }
      const updatedProfile: CandidateProfile = json.data;
      setProfile(updatedProfile);
      setPersonalForm({
        fullName: updatedProfile.fullName || '',
        email: updatedProfile.email || '',
        phone: updatedProfile.phone || '',
        degree: updatedProfile.degree || '',
        fieldOfStudy: updatedProfile.fieldOfStudy || '',
        institution: updatedProfile.institution || '',
        graduationYear: updatedProfile.graduationYear || '',
      });
      setLinksForm({
        linkedin: updatedProfile.linkedin || '',
        github: updatedProfile.github || '',
        portfolio: updatedProfile.portfolio || '',
        otherLink: updatedProfile.otherLink || '',
      });
      setSkillsState(updatedProfile.skills || {
        languages: [],
        frameworks: [],
        databases: [],
        cloudDevOps: [],
        tools: [],
        other: [],
      });

      if (successMsg) {
        setStatusMessage(successMsg);
        setTimeout(() => setStatusMessage(null), 4000);
      }
      return updatedProfile;
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error updating candidate profile.');
      throw err;
    }
  };

  // Section 1: Save Personal Details
  const handleSavePersonal = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPersonal(true);
    try {
      await saveProfileUpdates(personalForm, 'Personal & contact details saved successfully!');
    } finally {
      setSavingPersonal(false);
    }
  };

  // Section 2: Save Links
  const handleSaveLinks = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingLinks(true);
    try {
      await saveProfileUpdates(linksForm, 'Professional links saved successfully!');
    } finally {
      setSavingLinks(false);
    }
  };

  // Section 6: Add / Remove / Save Skills
  const handleAddSkill = (category: keyof CandidateSkills) => {
    const val = (newSkillInput[category] || '').trim();
    if (!val) return;
    if (skillsState[category]?.includes(val)) return;

    const nextCategorySkills = [...(skillsState[category] || []), val];
    const nextSkills = { ...skillsState, [category]: nextCategorySkills };
    setSkillsState(nextSkills);
    setNewSkillInput({ ...newSkillInput, [category]: '' });
  };

  const handleRemoveSkill = (category: keyof CandidateSkills, itemToRemove: string) => {
    const nextCategorySkills = (skillsState[category] || []).filter((s) => s !== itemToRemove);
    const nextSkills = { ...skillsState, [category]: nextCategorySkills };
    setSkillsState(nextSkills);
  };

  const handleSaveSkills = async () => {
    setSavingSkills(true);
    try {
      await saveProfileUpdates({ skills: skillsState }, 'Technical skills saved successfully!');
    } finally {
      setSavingSkills(false);
    }
  };

  // Section 3: Education Dialog Handlers
  const openAddEducation = () => {
    setEduForm({
      institution: '',
      degree: '',
      fieldOfStudy: '',
      year: '',
      gpa: '',
      highlights: [],
    });
    setEduHighlightsText('');
    setEditingIndex(null);
    setActiveModal('education');
  };

  const openEditEducation = (idx: number) => {
    const item = profile.education[idx];
    setEduForm(item);
    setEduHighlightsText((item.highlights || []).join('\n'));
    setEditingIndex(idx);
    setActiveModal('education');
  };

  const handleSaveEducationModal = async () => {
    const highlights = eduHighlightsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const item: CandidateEducation = {
      id: eduForm.id || `edu_${Date.now()}`,
      institution: (eduForm.institution || '').trim(),
      degree: (eduForm.degree || '').trim(),
      fieldOfStudy: (eduForm.fieldOfStudy || '').trim(),
      year: (eduForm.year || '').trim(),
      gpa: (eduForm.gpa || '').trim(),
      highlights,
    };

    if (!item.institution && !item.degree) {
      alert('Please provide at least an institution or degree name.');
      return;
    }

    let nextEdu = [...profile.education];
    if (editingIndex !== null) {
      nextEdu[editingIndex] = item;
    } else {
      nextEdu.push(item);
    }

    await saveProfileUpdates({ education: nextEdu }, 'Education details updated.');
    setActiveModal(null);
  };

  const handleDeleteEducation = async (idx: number) => {
    if (!confirm('Are you sure you want to delete this education entry?')) return;
    const nextEdu = profile.education.filter((_, i) => i !== idx);
    await saveProfileUpdates({ education: nextEdu }, 'Education entry removed.');
  };

  // Section 4: Experience Dialog Handlers
  const openAddExperience = () => {
    setExpForm({
      company: '',
      role: '',
      duration: '',
      location: '',
      highlights: [],
      technologies: [],
    });
    setExpHighlightsText('');
    setExpTechText('');
    setEditingIndex(null);
    setActiveModal('experience');
  };

  const openEditExperience = (idx: number) => {
    const item = profile.experience[idx];
    setExpForm(item);
    setExpHighlightsText((item.highlights || []).join('\n'));
    setExpTechText((item.technologies || []).join(', '));
    setEditingIndex(idx);
    setActiveModal('experience');
  };

  const handleSaveExperienceModal = async () => {
    const highlights = expHighlightsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const technologies = expTechText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const item: CandidateExperience = {
      id: expForm.id || `exp_${Date.now()}`,
      company: (expForm.company || '').trim(),
      role: (expForm.role || '').trim(),
      duration: (expForm.duration || '').trim(),
      location: (expForm.location || '').trim(),
      highlights,
      technologies,
    };

    if (!item.company && !item.role) {
      alert('Please provide at least a company name or role.');
      return;
    }

    let nextExp = [...profile.experience];
    if (editingIndex !== null) {
      nextExp[editingIndex] = item;
    } else {
      nextExp.push(item);
    }

    await saveProfileUpdates({ experience: nextExp }, 'Experience details updated.');
    setActiveModal(null);
  };

  const handleDeleteExperience = async (idx: number) => {
    if (!confirm('Are you sure you want to delete this experience entry?')) return;
    const nextExp = profile.experience.filter((_, i) => i !== idx);
    await saveProfileUpdates({ experience: nextExp }, 'Experience entry removed.');
  };

  // Section 5: Project Dialog Handlers
  const openAddProject = () => {
    setProjForm({
      name: '',
      duration: '',
      description: '',
      techStack: [],
      highlights: [],
      liveUrl: '',
      githubUrl: '',
    });
    setProjTechText('');
    setProjHighlightsText('');
    setEditingIndex(null);
    setActiveModal('project');
  };

  const openEditProject = (idx: number) => {
    const item = profile.projects[idx];
    setProjForm(item);
    setProjTechText((item.techStack || []).join(', '));
    setProjHighlightsText((item.highlights || []).join('\n'));
    setEditingIndex(idx);
    setActiveModal('project');
  };

  const handleSaveProjectModal = async () => {
    const techStack = projTechText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const highlights = projHighlightsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const item: CandidateProject = {
      id: projForm.id || `proj_${Date.now()}`,
      name: (projForm.name || '').trim(),
      duration: (projForm.duration || '').trim(),
      description: (projForm.description || '').trim(),
      techStack,
      highlights,
      liveUrl: (projForm.liveUrl || '').trim() || undefined,
      githubUrl: (projForm.githubUrl || '').trim() || undefined,
    };

    if (!item.name) {
      alert('Please provide a project name.');
      return;
    }

    let nextProj = [...profile.projects];
    if (editingIndex !== null) {
      nextProj[editingIndex] = item;
    } else {
      nextProj.push(item);
    }

    await saveProfileUpdates({ projects: nextProj }, 'Project details updated.');
    setActiveModal(null);
  };

  const handleDeleteProject = async (idx: number) => {
    if (!confirm('Are you sure you want to delete this project entry?')) return;
    const nextProj = profile.projects.filter((_, i) => i !== idx);
    await saveProfileUpdates({ projects: nextProj }, 'Project entry removed.');
  };

  // Section 7: Achievement Dialog Handlers
  const openAddAchievement = () => {
    setAchForm({
      title: '',
      description: '',
      year: '',
    });
    setEditingIndex(null);
    setActiveModal('achievement');
  };

  const openEditAchievement = (idx: number) => {
    const item = profile.achievements[idx];
    setAchForm(item);
    setEditingIndex(idx);
    setActiveModal('achievement');
  };

  const handleSaveAchievementModal = async () => {
    const item: CandidateAchievement = {
      id: achForm.id || `ach_${Date.now()}`,
      title: (achForm.title || '').trim(),
      description: (achForm.description || '').trim(),
      year: (achForm.year || '').trim(),
    };

    if (!item.title) {
      alert('Please provide an achievement title.');
      return;
    }

    let nextAch = [...profile.achievements];
    if (editingIndex !== null) {
      nextAch[editingIndex] = item;
    } else {
      nextAch.push(item);
    }

    await saveProfileUpdates({ achievements: nextAch }, 'Achievement updated.');
    setActiveModal(null);
  };

  const handleDeleteAchievement = async (idx: number) => {
    if (!confirm('Are you sure you want to delete this achievement?')) return;
    const nextAch = profile.achievements.filter((_, i) => i !== idx);
    await saveProfileUpdates({ achievements: nextAch }, 'Achievement removed.');
  };

  // Resume PDF File Upload Handler (Zero AI, only saves file for Gmail MIME attachment)
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setErrorMessage('Please upload a PDF file.');
      return;
    }

    setUploadingResume(true);
    setErrorMessage(null);
    setStatusMessage('Uploading resume PDF attachment...');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/resume', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to upload resume.');
      }

      setResumeData(json.data.resume);
      setStatusMessage('Resume PDF uploaded successfully for Gmail outreach email attachments!');
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error uploading resume PDF.');
    } finally {
      setUploadingResume(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Gmail Handlers
  const handleConnectGmail = () => {
    window.location.href = '/api/gmail/auth';
  };

  const handleDisconnectGmail = async () => {
    if (!confirm('Are you sure you want to disconnect Gmail? Automated outreach will be paused.')) return;
    setIsDisconnecting(true);
    try {
      const res = await fetch('/api/gmail/disconnect', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setGmailStatus({ connected: false, email: null });
        setStatusMessage('Gmail disconnected.');
        setTimeout(() => setStatusMessage(null), 4000);
      }
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!testRecipient) return;
    setIsSendingTest(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/gmail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: testRecipient }),
      });
      const json = await res.json();
      setTestResult({
        success: json.success,
        message: json.success
          ? 'Live integration test email sent successfully via Gmail API!'
          : json.error || 'Failed to send test email',
        messageId: json.data?.messageId,
      });
    } catch {
      setTestResult({
        success: false,
        message: 'Network error sending test email.',
      });
    } finally {
      setIsSendingTest(false);
    }
  };

  // Scheduler Handlers
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

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const skillCategoriesList: Array<{ key: keyof CandidateSkills; label: string; placeholder: string }> = [
    { key: 'languages', label: 'Languages', placeholder: 'e.g. TypeScript, Python, C++, Go' },
    { key: 'frameworks', label: 'Frameworks & Libraries', placeholder: 'e.g. Next.js, React, Node.js, Express' },
    { key: 'databases', label: 'Databases', placeholder: 'e.g. PostgreSQL, SQLite, Redis, MongoDB' },
    { key: 'cloudDevOps', label: 'Cloud & DevOps', placeholder: 'e.g. Docker, AWS, Railway, CI/CD' },
    { key: 'tools', label: 'Developer Tools', placeholder: 'e.g. Git, Postman, Linux, TailwindCSS' },
    { key: 'other', label: 'Other Skills', placeholder: 'e.g. REST APIs, Microservices, Agile' },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-16">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings & Candidate Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your persistent candidate profile, professional links, resume attachment, and outreach controls.
        </p>
      </div>

      {/* Global Alerts */}
      {statusMessage && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          SECTION 1: PERSONAL & CONTACT DETAILS
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-primary" />
            <CardTitle>1. Personal & Contact Details</CardTitle>
          </div>
          <CardDescription>
            Your core personal and academic credentials. Used directly in outreach signatures and candidate dossiers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSavePersonal} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Full Name</label>
                <input
                  type="text"
                  value={personalForm.fullName}
                  onChange={(e) => setPersonalForm({ ...personalForm, fullName: e.target.value })}
                  placeholder="Aditya Raj Singh"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email Address</label>
                <input
                  type="email"
                  value={personalForm.email}
                  onChange={(e) => setPersonalForm({ ...personalForm, email: e.target.value })}
                  placeholder="aditya@example.com"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Phone Number</label>
                <input
                  type="text"
                  value={personalForm.phone}
                  onChange={(e) => setPersonalForm({ ...personalForm, phone: e.target.value })}
                  placeholder="+91 9876543210"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Primary Degree</label>
                <input
                  type="text"
                  value={personalForm.degree}
                  onChange={(e) => setPersonalForm({ ...personalForm, degree: e.target.value })}
                  placeholder="B.Tech"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Field of Study</label>
                <input
                  type="text"
                  value={personalForm.fieldOfStudy}
                  onChange={(e) => setPersonalForm({ ...personalForm, fieldOfStudy: e.target.value })}
                  placeholder="Computer Science and Engineering"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Institution / University</label>
                <input
                  type="text"
                  value={personalForm.institution}
                  onChange={(e) => setPersonalForm({ ...personalForm, institution: e.target.value })}
                  placeholder="LNJPIT Chapra"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Graduation Year</label>
                <input
                  type="text"
                  value={personalForm.graduationYear}
                  onChange={(e) => setPersonalForm({ ...personalForm, graduationYear: e.target.value })}
                  placeholder="2025"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={savingPersonal}>
                {savingPersonal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Personal Details
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SECTION 2: PROFESSIONAL LINKS (AUTHORITATIVE)
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5 text-primary" />
            <CardTitle>2. Professional Links</CardTitle>
          </div>
          <CardDescription>
            Exact, verified URLs for your online presence. Included in outreach emails and signatures verbatim.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveLinks} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">LinkedIn URL</label>
                <input
                  type="url"
                  value={linksForm.linkedin}
                  onChange={(e) => setLinksForm({ ...linksForm, linkedin: e.target.value })}
                  placeholder="https://linkedin.com/in/yourprofile"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">GitHub URL</label>
                <input
                  type="url"
                  value={linksForm.github}
                  onChange={(e) => setLinksForm({ ...linksForm, github: e.target.value })}
                  placeholder="https://github.com/yourusername"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Portfolio Website</label>
                <input
                  type="url"
                  value={linksForm.portfolio}
                  onChange={(e) => setLinksForm({ ...linksForm, portfolio: e.target.value })}
                  placeholder="https://yourportfolio.dev"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Other Link / Blog</label>
                <input
                  type="url"
                  value={linksForm.otherLink}
                  onChange={(e) => setLinksForm({ ...linksForm, otherLink: e.target.value })}
                  placeholder="https://yourblog.com"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={savingLinks}>
                {savingLinks ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Professional Links
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SECTION 3: EDUCATION DETAILS
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>3. Education Details ({profile.education.length})</CardTitle>
                <CardDescription>Academic history, degrees, grades, and academic achievements.</CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={openAddEducation}>
              <Plus className="h-4 w-4" /> Add Education
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {profile.education.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No education records added yet. Click &quot;Add Education&quot; to define your academic qualifications.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {profile.education.map((edu, idx) => (
                <div key={edu.id || idx} className="relative rounded-lg border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-semibold text-foreground">{edu.degree}</h4>
                      <p className="text-sm font-medium text-primary">{edu.institution}</p>
                      {edu.fieldOfStudy && (
                        <p className="text-xs text-muted-foreground">{edu.fieldOfStudy}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditEducation(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteEducation(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {edu.year && <Badge variant="outline">Year: {edu.year}</Badge>}
                    {edu.gpa && <Badge variant="outline">GPA/Score: {edu.gpa}</Badge>}
                  </div>

                  {edu.highlights && edu.highlights.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {edu.highlights.map((h, hIdx) => (
                        <li key={hIdx}>{h}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SECTION 4: EXPERIENCE DETAILS
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Briefcase className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>4. Experience Details ({profile.experience.length})</CardTitle>
                <CardDescription>Professional roles, internships, responsibilities, and achievements.</CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={openAddExperience}>
              <Plus className="h-4 w-4" /> Add Experience
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {profile.experience.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No professional experience added yet. Click &quot;Add Experience&quot; to add internships or jobs.
            </div>
          ) : (
            <div className="space-y-4">
              {profile.experience.map((exp, idx) => (
                <div key={exp.id || idx} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-semibold text-foreground">{exp.role}</h4>
                      <p className="text-sm font-medium text-primary">{exp.company}</p>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {exp.duration && <span>{exp.duration}</span>}
                        {exp.location && <span>• {exp.location}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditExperience(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteExperience(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {exp.highlights && exp.highlights.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {exp.highlights.map((h, hIdx) => (
                        <li key={hIdx}>{h}</li>
                      ))}
                    </ul>
                  )}

                  {exp.technologies && exp.technologies.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {exp.technologies.map((t, tIdx) => (
                        <Badge key={tIdx} variant="secondary" className="text-[11px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SECTION 5: PROJECT DETAILS
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderGit2 className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>5. Project Details ({profile.projects.length})</CardTitle>
                <CardDescription>
                  Your technical and engineering projects. You define the exact names, tech stack, and highlights.
                </CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={openAddProject}>
              <Plus className="h-4 w-4" /> Add Project
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {profile.projects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No projects added yet. Click &quot;Add Project&quot; to showcase your real software applications.
            </div>
          ) : (
            <div className="space-y-4">
              {profile.projects.map((proj, idx) => (
                <div key={proj.id || idx} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-foreground">{proj.name}</h4>
                        {proj.duration && (
                          <span className="text-xs text-muted-foreground">({proj.duration})</span>
                        )}
                      </div>
                      {proj.description && (
                        <p className="mt-1 text-sm text-muted-foreground">{proj.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditProject(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteProject(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {proj.techStack && proj.techStack.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {proj.techStack.map((tech, tIdx) => (
                        <Badge key={tIdx} variant="secondary" className="text-[11px]">
                          {tech}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {proj.highlights && proj.highlights.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {proj.highlights.map((h, hIdx) => (
                        <li key={hIdx}>{h}</li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3 flex items-center gap-3 text-xs">
                    {proj.liveUrl && (
                      <a
                        href={proj.liveUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Live Demo
                      </a>
                    )}
                    {proj.githubUrl && (
                      <a
                        href={proj.githubUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <Code2 className="h-3.5 w-3.5" /> Source Code
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SECTION 6: TECHNICAL SKILLS (CATEGORIZED)
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Code2 className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>6. Technical Skills</CardTitle>
                <CardDescription>
                  Organized by category. Add and remove tags to match your skills with complete accuracy.
                </CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={handleSaveSkills} disabled={savingSkills}>
              {savingSkills ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Skills
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {skillCategoriesList.map(({ key, label, placeholder }) => {
            const currentTags = skillsState[key] || [];
            return (
              <div key={key} className="space-y-2 border-b border-border/50 pb-4 last:border-b-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wider">{label}</span>
                  <span className="text-xs text-muted-foreground">{currentTags.length} tags</span>
                </div>

                {/* Chips */}
                <div className="flex flex-wrap gap-1.5">
                  {currentTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => handleRemoveSkill(key, tag)}
                        className="rounded-full hover:bg-primary/20"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {currentTags.length === 0 && (
                    <span className="text-xs italic text-muted-foreground">No tags in this category.</span>
                  )}
                </div>

                {/* Add Input */}
                <div className="flex gap-2 pt-1">
                  <input
                    type="text"
                    value={newSkillInput[key] || ''}
                    onChange={(e) => setNewSkillInput({ ...newSkillInput, [key]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddSkill(key);
                      }
                    }}
                    placeholder={placeholder}
                    className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <Button size="sm" variant="secondary" onClick={() => handleAddSkill(key)}>
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SECTION 7: ACHIEVEMENTS & HONORS
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Award className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>7. Achievements & Honors ({profile.achievements.length})</CardTitle>
                <CardDescription>Competitive programming, hackathons, academic awards, and recognition.</CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={openAddAchievement}>
              <Plus className="h-4 w-4" /> Add Achievement
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {profile.achievements.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No achievements recorded yet. Click &quot;Add Achievement&quot; to include hackathons or awards.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {profile.achievements.map((ach, idx) => (
                <div key={ach.id || idx} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-foreground">{ach.title}</h4>
                        {ach.year && <span className="text-xs text-muted-foreground">({ach.year})</span>}
                      </div>
                      {ach.description && (
                        <p className="mt-1 text-xs text-muted-foreground">{ach.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditAchievement(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteAchievement(idx)}
                        className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SEPARATE CARD: RESUME PDF ATTACHMENT
      ───────────────────────────────────────────────────────────── */}
      <Card className="border-primary/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <CardTitle>Resume PDF Attachment</CardTitle>
          </div>
          <CardDescription>
            This PDF is used exclusively as a physical email attachment sent via Gmail outreach.
            The AI does not interpret or parse this PDF — your outreach facts are derived 100% authoritatively
            from your Candidate Profile above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".pdf"
            className="hidden"
          />

          {resumeData ? (
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-foreground">{resumeData.filename}</p>
                  <Badge variant="success">Attached</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Uploaded: {formatDateTime(resumeData.uploadedAt)}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <a
                  href="/api/resume/file?inline=true"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex"
                >
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-4 w-4" /> Preview PDF
                  </Button>
                </a>

                <a href="/api/resume/file" download={resumeData.filename} className="inline-flex">
                  <Button variant="outline" size="sm">
                    <Download className="h-4 w-4" /> Download
                  </Button>
                </a>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingResume}
                >
                  {uploadingResume ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Replace PDF
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center">
              <FileText className="h-10 w-10 text-muted-foreground/50 mb-2" />
              <p className="font-medium text-foreground">No Resume PDF Attached</p>
              <p className="text-xs text-muted-foreground mb-4">
                Upload your resume PDF so it can be automatically attached to outbound outreach emails.
              </p>
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingResume}
              >
                {uploadingResume ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload Resume PDF
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          GMAIL OAUTH INTEGRATION CARD
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            <CardTitle>Gmail Integration</CardTitle>
          </div>
          <CardDescription>
            Connect your Gmail account via OAuth 2.0 to send verified outreach emails.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">Account Status:</span>
                {gmailStatus.connected ? (
                  <Badge variant="success">Connected</Badge>
                ) : (
                  <Badge variant="secondary">Not Connected</Badge>
                )}
              </div>
              {gmailStatus.connected && (
                <p className="text-sm text-muted-foreground">{gmailStatus.email}</p>
              )}
            </div>

            <div>
              {gmailStatus.connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnectGmail}
                  disabled={isDisconnecting}
                  className="text-red-600 hover:bg-red-50 hover:text-red-700"
                >
                  {isDisconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                  Disconnect
                </Button>
              ) : (
                <Button onClick={handleConnectGmail}>
                  <Mail className="h-4 w-4" /> Connect Gmail
                </Button>
              )}
            </div>
          </div>

          {/* Test Email Section */}
          {gmailStatus.connected && (
            <div className="border-t border-border pt-4">
              <h4 className="text-sm font-semibold text-foreground mb-1">Live Integration Test</h4>
              <p className="text-xs text-muted-foreground mb-3">
                Send a live test email through Gmail API with your attached PDF to verify configuration.
              </p>
              <div className="flex gap-2 max-w-md">
                <input
                  type="email"
                  value={testRecipient}
                  onChange={(e) => setTestRecipient(e.target.value)}
                  placeholder="recipient@example.com"
                  className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <Button
                  size="sm"
                  onClick={handleSendTestEmail}
                  disabled={isSendingTest || !testRecipient}
                >
                  {isSendingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send Test
                </Button>
              </div>

              {testResult && (
                <div
                  className={`mt-3 rounded-md p-3 text-xs font-medium ${
                    testResult.success
                      ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border border-red-200 bg-red-50 text-red-800'
                  }`}
                >
                  {testResult.message}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          SCHEDULER SETTINGS CARD
      ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <CardTitle>Sending Window & Scheduler</CardTitle>
          </div>
          <CardDescription>
            Outreach emails are automatically paced within the allowed daily window (10:00 AM – 4:00 PM IST).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-background p-3">
              <span className="text-xs text-muted-foreground">Timezone</span>
              <p className="font-semibold text-foreground">{scheduler?.timezone || 'Asia/Kolkata'}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <span className="text-xs text-muted-foreground">Sending Window</span>
              <p className="font-semibold text-foreground">10:00 AM – 4:00 PM IST</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <span className="text-xs text-muted-foreground">Send Interval</span>
              <p className="font-semibold text-foreground">{scheduler?.intervalMinutes || 3} Minutes</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {scheduler?.isPaused ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleResumeScheduler}
                disabled={schedulerActionLoading}
              >
                <Play className="h-4 w-4 text-emerald-600" /> Resume Outreach
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handlePauseScheduler}
                disabled={schedulerActionLoading}
              >
                <Pause className="h-4 w-4 text-amber-600" /> Pause Outreach
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={handleStopScheduler}
              disabled={schedulerActionLoading}
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              <Square className="h-4 w-4" /> Stop Campaign
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────────────────────
          MODALS FOR EDUCATION, EXPERIENCE, PROJECTS, ACHIEVEMENTS
      ───────────────────────────────────────────────────────────── */}
      {/* Education Modal */}
      {activeModal === 'education' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground">
                {editingIndex !== null ? 'Edit Education' : 'Add Education'}
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">Institution / University *</label>
                <input
                  type="text"
                  value={eduForm.institution || ''}
                  onChange={(e) => setEduForm({ ...eduForm, institution: e.target.value })}
                  placeholder="LNJPIT Chapra"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Degree *</label>
                  <input
                    type="text"
                    value={eduForm.degree || ''}
                    onChange={(e) => setEduForm({ ...eduForm, degree: e.target.value })}
                    placeholder="B.Tech"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Field of Study</label>
                  <input
                    type="text"
                    value={eduForm.fieldOfStudy || ''}
                    onChange={(e) => setEduForm({ ...eduForm, fieldOfStudy: e.target.value })}
                    placeholder="Computer Science"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Year / Duration</label>
                  <input
                    type="text"
                    value={eduForm.year || ''}
                    onChange={(e) => setEduForm({ ...eduForm, year: e.target.value })}
                    placeholder="2021 - 2025"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">GPA / Percentage</label>
                  <input
                    type="text"
                    value={eduForm.gpa || ''}
                    onChange={(e) => setEduForm({ ...eduForm, gpa: e.target.value })}
                    placeholder="8.5 CGPA or 85%"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">
                  Highlights / Key Coursework (one per line)
                </label>
                <textarea
                  rows={3}
                  value={eduHighlightsText}
                  onChange={(e) => setEduHighlightsText(e.target.value)}
                  placeholder="Data Structures & Algorithms&#10;Database Management Systems&#10;Graduated with First Class Distinction"
                  className="mt-1 w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActiveModal(null)}>
                Cancel
              </Button>
              <Button onClick={handleSaveEducationModal}>
                Save Education
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Experience Modal */}
      {activeModal === 'experience' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground">
                {editingIndex !== null ? 'Edit Experience' : 'Add Experience'}
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Role / Title *</label>
                  <input
                    type="text"
                    value={expForm.role || ''}
                    onChange={(e) => setExpForm({ ...expForm, role: e.target.value })}
                    placeholder="Software Engineer Intern"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Company *</label>
                  <input
                    type="text"
                    value={expForm.company || ''}
                    onChange={(e) => setExpForm({ ...expForm, company: e.target.value })}
                    placeholder="Acme Tech"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Duration</label>
                  <input
                    type="text"
                    value={expForm.duration || ''}
                    onChange={(e) => setExpForm({ ...expForm, duration: e.target.value })}
                    placeholder="Jan 2024 - Jun 2024"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Location</label>
                  <input
                    type="text"
                    value={expForm.location || ''}
                    onChange={(e) => setExpForm({ ...expForm, location: e.target.value })}
                    placeholder="Bengaluru (Remote)"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">Technologies (comma-separated)</label>
                <input
                  type="text"
                  value={expTechText}
                  onChange={(e) => setExpTechText(e.target.value)}
                  placeholder="React, TypeScript, Node.js, PostgreSQL"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">
                  Highlights & Responsibilities (one per line)
                </label>
                <textarea
                  rows={4}
                  value={expHighlightsText}
                  onChange={(e) => setExpHighlightsText(e.target.value)}
                  placeholder="Engineered microservice that reduced latency by 35%&#10;Built responsive dashboards using Next.js and TailwindCSS&#10;Wrote automated integration test suites with 90% coverage"
                  className="mt-1 w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActiveModal(null)}>
                Cancel
              </Button>
              <Button onClick={handleSaveExperienceModal}>
                Save Experience
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Project Modal */}
      {activeModal === 'project' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground">
                {editingIndex !== null ? 'Edit Project' : 'Add Project'}
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Project Name *</label>
                  <input
                    type="text"
                    value={projForm.name || ''}
                    onChange={(e) => setProjForm({ ...projForm, name: e.target.value })}
                    placeholder="Distributed Job Scheduler"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Duration</label>
                  <input
                    type="text"
                    value={projForm.duration || ''}
                    onChange={(e) => setProjForm({ ...projForm, duration: e.target.value })}
                    placeholder="3 months"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">Summary / Problem Solved</label>
                <input
                  type="text"
                  value={projForm.description || ''}
                  onChange={(e) => setProjForm({ ...projForm, description: e.target.value })}
                  placeholder="High-throughput distributed workflow coordinator with automatic failover"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">Tech Stack (comma-separated)</label>
                <input
                  type="text"
                  value={projTechText}
                  onChange={(e) => setProjTechText(e.target.value)}
                  placeholder="Go, Redis, Docker, gRPC"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Live Demo URL</label>
                  <input
                    type="url"
                    value={projForm.liveUrl || ''}
                    onChange={(e) => setProjForm({ ...projForm, liveUrl: e.target.value })}
                    placeholder="https://myscheduler.live"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase">GitHub URL</label>
                  <input
                    type="url"
                    value={projForm.githubUrl || ''}
                    onChange={(e) => setProjForm({ ...projForm, githubUrl: e.target.value })}
                    placeholder="https://github.com/myrepo"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">
                  Highlights & Key Architecture (one per line)
                </label>
                <textarea
                  rows={4}
                  value={projHighlightsText}
                  onChange={(e) => setProjHighlightsText(e.target.value)}
                  placeholder="Processed 10,000+ asynchronous events/sec with sub-millisecond dispatch&#10;Engineered atomic leasing using Redis distributed locks&#10;Integrated Docker containerization for automated local testing"
                  className="mt-1 w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActiveModal(null)}>
                Cancel
              </Button>
              <Button onClick={handleSaveProjectModal}>
                Save Project
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Achievement Modal */}
      {activeModal === 'achievement' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground">
                {editingIndex !== null ? 'Edit Achievement' : 'Add Achievement'}
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">Title *</label>
                <input
                  type="text"
                  value={achForm.title || ''}
                  onChange={(e) => setAchForm({ ...achForm, title: e.target.value })}
                  placeholder="Winner - Smart India Hackathon 2024"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">Year</label>
                <input
                  type="text"
                  value={achForm.year || ''}
                  onChange={(e) => setAchForm({ ...achForm, year: e.target.value })}
                  placeholder="2024"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase">Description / Details</label>
                <textarea
                  rows={3}
                  value={achForm.description || ''}
                  onChange={(e) => setAchForm({ ...achForm, description: e.target.value })}
                  placeholder="Ranked 1st among 250+ teams nationally for building an automated disaster response portal."
                  className="mt-1 w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActiveModal(null)}>
                Cancel
              </Button>
              <Button onClick={handleSaveAchievementModal}>
                Save Achievement
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
