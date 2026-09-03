import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(normalizeEmail(email));
}

export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    processing: 'text-blue-600 bg-blue-50',
    queued: 'text-amber-600 bg-amber-50',
    sending: 'text-indigo-600 bg-indigo-50',
    paused: 'text-orange-600 bg-orange-50',
    completed: 'text-emerald-600 bg-emerald-50',
    failed: 'text-red-600 bg-red-50',
    discovered: 'text-slate-600 bg-slate-50',
    generated: 'text-violet-600 bg-violet-50',
    sent: 'text-emerald-600 bg-emerald-50',
    skipped: 'text-gray-600 bg-gray-50',
    pending: 'text-amber-600 bg-amber-50',
    cancelled: 'text-gray-600 bg-gray-50',
  };
  return colors[status] || 'text-gray-600 bg-gray-50';
}
