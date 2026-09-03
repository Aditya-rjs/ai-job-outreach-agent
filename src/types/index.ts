export interface DashboardStats {
  totalCompanies: number;
  relevantCompanies: number;
  totalContacts: number;
  emailsSent: number;
  emailsFailed: number;
  emailsQueued: number;
  emailsGenerated: number;
  emailsSkipped: number;
  emailsUncertain: number;
  todaySentCount: number;
  dailyLimit: number;
  remainingToday: number;
  nextSendAt: string | null;
  lastSendAt: string | null;
  queueSize: number;
  isPaused: boolean;
  isStopped: boolean;
  isDryRun: boolean;
  gmailConnected: boolean;
  gmailEmail: string | null;
  outreachStatus: 'idle' | 'running' | 'sending' | 'paused' | 'stopped' | 'waiting' | 'completed' | 'quota_reached';
}

// Batch types
export interface Batch {
  id: string;
  filename: string;
  uploadDate: string;
  totalRecords: number;
  validRecords: number;
  relevantCompanies: number;
  irrelevantCompanies: number;
  duplicateContacts: number;
  invalidEmails: number;
  emailsSent: number;
  emailsFailed: number;
  emailsPending: number;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
}

export type BatchStatus = 'processing' | 'queued' | 'sending' | 'paused' | 'completed' | 'failed';

// Contact types
export interface Contact {
  id: string;
  batchId: string;
  companyName: string | null;
  contactName: string | null;
  email: string;
  designation: string | null;
  companyWebsite: string | null;
  companyLocation: string | null;
  isRelevant: boolean | null;
  relevanceConfidence: number | null;
  relevanceReason: string | null;
  isDuplicate: boolean;
  emailValid: boolean;
  status: ContactStatus;
  emailSubject: string | null;
  emailBody: string | null;
  emailStrategy: string | null;
  personalizationPoints: string | null;
  resumeVersion: string | null;
  generatedAt: string | null;
  gmailMessageId: string | null;
  sentAt: string | null;
  errorMessage: string | null;
  sendAttemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ContactStatus =
  | 'discovered'
  | 'queued'
  | 'generating'
  | 'generated'
  | 'processing'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'uncertain';

// Queue types
export interface QueueItem {
  id: string;
  contactId: string;
  priority: number;
  scheduledFor: string | null;
  status: QueueStatus;
  attempts: number;
  leaseExpiresAt: string | null;
  workerId: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type QueueStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain'
  | 'blocked';

// Scheduler types
export interface SchedulerConfig {
  isPaused: boolean;
  isStopped: boolean;
  todaySentCount: number;
  todayDate: string | null;
  lastSendAt: string | null;
  lastSendAttemptAt: string | null;
  nextSendAt: string | null;
  timezone: string;
  dailyLimit: number;
  intervalMinutes: number;
  startHour: number;
  startMinute: number;
  workerId: string | null;
  lockedUntil: string | null;
  lastHeartbeatAt: string | null;
  isDryRun: boolean;
  schedulerStatus: 'running' | 'paused' | 'stopped' | 'waiting' | 'quota_reached';
}

// Structured Resume Profile
export interface StructuredResumeProfile {
  name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  education: Array<{
    degree: string;
    institution: string;
    year?: string;
    gpa?: string;
  }>;
  skills: {
    languages: string[];
    frameworks: string[];
    databases: string[];
    cloudDevOps: string[];
    tools: string[];
    other: string[];
  };
  experience: Array<{
    role: string;
    company: string;
    duration?: string;
    description?: string;
    highlights: string[];
  }>;
  projects: Array<{
    title: string;
    description?: string;
    techStack: string[];
    highlights: string[];
  }>;
  certifications: string[];
  achievements: string[];
  summary: string;
}

// Resume entity
export interface ResumeData {
  id: string;
  filename: string;
  filePath: string;
  mimeType: string;
  parsedText: string | null;
  parsedData: string | null; // JSON string of StructuredResumeProfile
  version: string | null;
  uploadedAt: string;
}

// Settings
export interface AppSettings {
  gmailConnected: boolean;
  gmailEmail: string;
  scheduler: SchedulerConfig;
  resumeUploaded: boolean;
  resumeFilename: string | null;
  resumeVersion: string | null;
  resumeProfile?: StructuredResumeProfile | null;
}

// AI Generated Email Result
export interface GeneratedEmailResult {
  subject: string;
  body: string;
  strategy: string;
  personalization_points: string[];
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
