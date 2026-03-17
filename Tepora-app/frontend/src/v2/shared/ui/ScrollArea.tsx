import React from 'react';

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`overflow-auto custom-scrollbar ${className}`}
        style={{
          scrollbarWidth: 'thin', // Firefox
        }}
        {...props}
      >
        {/* custom-scrollbar class should be defined in tailwind.css/variables.css for webkit styles */}
        {children}
      </div>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';
