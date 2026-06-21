import type { ReactNode } from "react";

export function PageHeader({
  title,
  titleAfter,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  titleAfter?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-border/50 px-4 py-3 shrink-0 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-lg font-semibold lowercase leading-none truncate">
              {title}
            </h1>
            {titleAfter}
          </div>
          {subtitle && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}
