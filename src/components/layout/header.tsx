import { Badge } from '@/components/ui/badge';
import { MobileNav } from './mobile-nav';

export function Header() {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm lg:px-6">
      <div className="flex items-center gap-3">
        <MobileNav />
        <h1 className="text-base font-semibold text-foreground lg:text-lg">
          AI Job Outreach Agent
        </h1>
      </div>

      <div className="flex items-center gap-3">
        <Badge variant="secondary">
          Idle
        </Badge>
      </div>
    </header>
  );
}
