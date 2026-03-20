import React from 'react';

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'surface' | 'glass';
}

export const Panel = React.forwardRef<HTMLDivElement, PanelProps>(
  ({ className = '', variant = 'surface', children, ...props }, ref) => {
    const baseStyles = 'rounded-2xl overflow-hidden';
    
    const variantStyles = {
      surface: 'bg-surface shadow-sm border border-border',
      glass: 'bg-surface/75 backdrop-blur-[40px] shadow-2xl border border-white/5', // Glassmorphism for floating panels
    };

    return (
      <div
        ref={ref}
        className={`${baseStyles} ${variantStyles[variant]} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Panel.displayName = 'Panel';
