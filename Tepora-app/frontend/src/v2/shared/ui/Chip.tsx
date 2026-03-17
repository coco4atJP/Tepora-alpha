import React from 'react';

export interface ChipProps extends React.HTMLAttributes<HTMLDivElement> {
  active?: boolean;
  onRemove?: () => void;
}

export const Chip = React.forwardRef<HTMLDivElement, ChipProps>(
  ({ className = '', active, onRemove, children, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-sans transition-colors duration-200';
    
    const stateStyles = active
      ? 'bg-secondary/10 text-secondary border border-secondary/20'
      : 'bg-surface border border-border text-text-muted hover:text-text-main hover:bg-surface/80';

    return (
      <div
        ref={ref}
        className={`${baseStyles} ${stateStyles} ${className}`}
        {...props}
      >
        {children}
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="text-current opacity-60 hover:opacity-100 focus:outline-none"
            aria-label="Remove"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        )}
      </div>
    );
  }
);

Chip.displayName = 'Chip';
