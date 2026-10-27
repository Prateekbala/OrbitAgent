import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Skeleton } from './ui/skeleton';
import { Card } from './ui/card';

export function WorkspaceHeading({
  icon: Icon,
  eyebrow,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading workspace-section-heading">
      <div className="workspace-section-copy">
        <span className="workspace-section-eyebrow">
          <Icon size={14} aria-hidden="true" />
          {eyebrow}
        </span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children && <div className="workspace-section-actions">{children}</div>}
    </div>
  );
}

export function CollectionSkeleton({ label }: { label: string }) {
  return (
    <div className="workspace-collection-loading" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="card-grid" aria-hidden="true">
        {[0, 1, 2].map((item) => (
          <Card key={item} className="workspace-skeleton-card">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-9 w-full" />
          </Card>
        ))}
      </div>
    </div>
  );
}
