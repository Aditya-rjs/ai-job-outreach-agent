import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { ArrowUpRight } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
  onClick?: () => void;
  active?: boolean;
}

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  className,
  onClick,
  active = false,
}: StatCardProps) {
  const isClickable = Boolean(onClick);

  return (
    <div
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={isClickable ? `View details for ${title} (${value})` : undefined}
      onClick={onClick}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        'rounded-xl border border-border bg-card p-5 shadow-sm transition-all duration-150',
        isClickable &&
          'cursor-pointer hover:border-primary/60 hover:shadow-md hover:bg-card/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 group select-none',
        active && 'border-primary ring-2 ring-primary/20 bg-primary/5',
        className
      )}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1 min-w-0 pr-2">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-muted-foreground truncate">{title}</p>
            {isClickable && (
              <ArrowUpRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0" />
            )}
          </div>
          <p className="text-2xl font-bold text-foreground">{value}</p>
          {subtitle && (
            <p className="text-xs text-muted-foreground line-clamp-1">{subtitle}</p>
          )}
        </div>
        <div className="rounded-lg bg-primary/10 p-2.5 shrink-0 group-hover:bg-primary/20 transition-colors">
          <Icon className="h-5 w-5 text-primary" />
        </div>
      </div>
    </div>
  );
}

