import type { ProcessingPipelineStats } from '@/lib/processing-queries';

export interface DashboardStats {
  processingStats?: ProcessingPipelineStats;
  totalCompanies: number;
  relevantCompanies: number;
  totalContacts: number;
  emailsSent: number;
  emailsSimulated: number;
  emailsFailed: number;
  emailsQueued: number;
  emailsGenerated: number;
  emailsPendingGeneration: number;
  emailsGenerating: number;
  emailsGenerationRetryPending: number;
  emailsGenerationFailed: number;
  emailsSkipped: number;
  emailsUncertain: number;
  todaySentCount: number;
  todaySimulatedCount: number;
  dailyLimit: number;
  remainingToday: number;
  nextSendAt: string | null;
  lastSendAt: string | null;
  queueSize: number;
  isPaused: boolean;
  isStopped: boolean;
  isWindowOpen?: boolean;
  isDryRun: boolean;
  gmailConnected: boolean;
  gmailEmail: string | null;
  geminiTelemetry?: {
    currentModel: string;
    maxConcurrency: number;
    minDispatchGapMs?: number;
    effectivePacingMs?: number;
    inFlightRequests: number;
    queuedRequests: number;
    queueDepth?: number;
    totalRequests?: number;
    requestsStarted?: number;
    requestsSucceeded?: number;
    requestsFailed?: number;
    recent429Count: number;
    rateLimit429Count?: number;
    consecutive429Count?: number;
    isCooldownActive?: boolean;
    cooldownUntil?: string | null;
    cooldownRemainingSeconds?: number;
    recentTransientErrorCount: number;
    last429At?: string | null;
    lastTransientErrorAt?: string | null;
  };
  aiTelemetry?: {
    currentActiveProvider: 'gemini' | 'openrouter' | 'waiting';
    geminiCooldownActive: boolean;
    geminiCooldownUntil: string | null;
    geminiCooldownRemainingSeconds: number;
    geminiModelDisplay?: string;
    geminiPool?: any;
    openRouterCooldownActive?: boolean;
    openRouterCooldownUntil?: string | null;
    openRouterCooldownRemainingSeconds?: number;
    openRouterConfigured: boolean;
    openRouterModel: string;
    totalDispatches: number;
    geminiSuccesses: number;
    geminiFailures: number;
    gemini429Count: number;
    openRouterDispatches: number;
    openRouterSuccesses: number;
    openRouterFailures: number;
    fallbackCount: number;
    lastFallbackAt: string | null;
  };

  outreachStatus: 'idle' | 'running' | 'sending' | 'paused' | 'stopped' | 'waiting' | 'completed' | 'quota_reached';
}


export interface Batch {
  id: string;
  filename: string;
  filePath?: string | null;
  uploadDate: string;
  totalRecords: number;
  validRecords: number;
  relevantCompanies: number;
  irrelevantCompanies: number;
  duplicateContacts: number;
  invalidEmails: number;
  emailsSent: number;
  emailsSimulated?: number;
  emailsFailed: number;
  emailsPending: number;
  status: BatchStatus;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BatchStatus = 'processing' | 'queued' | 'sending' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'deleted';

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
  generationStatus?: GenerationStatus | null;
  generationAttemptCount?: number;
  generationClaimToken?: string | null;
  generationLeaseExpiresAt?: string | null;
  lastGenerationErrorCategory?: string | null;
  nextGenerationRetryAt?: string | null;
  lastGenerationAttemptAt?: string | null;
  retryQueueEnqueuedAt?: string | null;
  retryTurnStartedAt?: string | null;
  retryTurnConsumedMs?: number;
  createdAt: string;
  updatedAt: string;
}

export type GenerationStatus =
  | 'PENDING_GENERATION'
  | 'GENERATING'
  | 'GENERATED'
  | 'GENERATION_FAILED'
  | 'RETRY_PENDING';

export type ContactStatus =
  | 'discovered'
  | 'queued'
  | 'generating'
  | 'generated'
  | 'processing'
  | 'sending'
  | 'sent'
  | 'simulated'
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
  isWindowOpen: boolean;
  todaySentCount: number;
  todaySimulatedCount: number;
  todayDate: string | null;
  lastSendAt: string | null;
  lastSendAttemptAt: string | null;
  nextSendAt: string | null;
  timezone: string;
  dailyLimit: number;
  intervalMinutes: number;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  workerId: string | null;
  lockedUntil: string | null;
  lastHeartbeatAt: string | null;
  isDryRun: boolean;
  schedulerStatus: 'running' | 'paused' | 'stopped' | 'waiting' | 'quota_reached';
}

// User-verified profile links (distinct from resume-derived facts)
export interface VerifiedProfileLinks {
  linkedin?: string | null;
  github?: string | null;
  portfolio?: string | null;
  other?: string | null;
}

export interface ResumeEducation {
  degree: string;
  fieldOfStudy?: string | null;
  institution: string;
  boardOrUniversity?: string | null;
  year?: string;
  gpa?: string;
  score?: string;
  relevantCoursework?: string[];
  otherDetails?: string | null;
}

export interface ResumeSkills {
  languages: string[];
  frameworks: string[];
  databases: string[];
  cloudDevOps: string[];
  tools: string[];
  frontend?: string[];
  backend?: string[];
  webTechnologies?: string[];
  backendTechnologies?: string[];
  developerTools?: string[];
  coreConcepts?: string[];
  aiMl?: string[];
  dataScience?: string[];
  apisIntegrations?: string[];
  coreCs?: string[];
  other: string[];
}

export interface ResumeExperience {
  role: string;
  title?: string;
  company: string;
  employmentType?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  duration?: string;
  location?: string | null;
  description?: string;
  responsibilities?: string[];
  highlights: string[];
  bullets?: string[];
  technologies?: string[];
  tools?: string[];
  metrics?: string[];
}

export interface ResumeProject {
  title: string;
  duration?: string | null;
  description?: string;
  problemSolved?: string | null;
  techStack: string[];
  frameworks?: string[];
  databases?: string[];
  apis?: string[];
  architecture?: string | null;
  implementationDetails?: string | null;
  highlights: string[];
  bullets?: string[];
  metrics?: string[];
  deployment?: string | null;
  liveUrl?: string | null;
  githubUrl?: string | null;
}

export interface ResumeCertification {
  name: string;
  issuer?: string | null;
  date?: string | null;
  year?: string | null;
  credentialId?: string | null;
  url?: string | null;
}

export interface ResumeAchievement {
  title: string;
  description?: string | null;
  event?: string | null;
  rank?: string | null;
  count?: string | null;
  date?: string | null;
  year?: string | null;
  metrics?: string | null;
}

export interface ResumeLeadership {
  position?: string;
  role?: string;
  organization: string;
  duration?: string | null;
  period?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  description?: string | null;
  responsibilities?: string[];
  highlights?: string[];
}

export interface ResumeCustomSection {
  heading: string;
  content: string[];
}

// Structured Resume Profile (strictly resume-extracted facts)
export interface StructuredResumeProfile {
  name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  education: ResumeEducation[];
  skills: ResumeSkills;
  experience: ResumeExperience[];
  projects: ResumeProject[];
  certifications: Array<string | ResumeCertification>;
  achievements: Array<string | ResumeAchievement>;
  leadership?: ResumeLeadership[];
  customSections?: ResumeCustomSection[];
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
  candidateProfile?: CandidateProfile | null;
}

// Manual Authoritative Candidate Profile types
export interface CandidateEducation {
  id: string;
  institution: string;
  degree: string;
  fieldOfStudy?: string;
  year?: string;
  highlights?: string[];
}

export interface CandidateExperience {
  id: string;
  company: string;
  role: string;
  duration?: string;
  location?: string;
  highlights: string[];
  technologies?: string[];
}

export interface CandidateProject {
  id?: string;
  name?: string;
  title?: string;
  duration?: string;
  description?: string;
  techStack?: string[];
  technologies?: string[];
  highlights?: string[];
  liveUrl?: string;
  githubUrl?: string;
}

export interface CandidateSkills {
  programmingLanguages: string[];
  webDevelopment: string[];
  databasesOrms: string[];
  aiMl: string[];
  coreComputerScience: string[];
  toolsApis: string[];
}

export interface CandidateAchievement {
  id: string;
  title: string;
  description?: string;
  year?: string;
}

export interface CandidateProfile {
  fullName: string;
  email: string;
  phone: string;
  degree: string;
  fieldOfStudy: string;
  institution: string;
  graduationYear: string;
  linkedin: string;
  github: string;
  portfolio: string;
  education: CandidateEducation[];
  experience: CandidateExperience[];
  projects: CandidateProject[];
  skills: CandidateSkills;
  achievements: CandidateAchievement[];
  version: string;
  updatedAt: string;
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
