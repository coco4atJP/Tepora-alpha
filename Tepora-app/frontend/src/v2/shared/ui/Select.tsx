import React from 'react';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', error, children, ...props }, ref) => {
    const baseStyles = 'block w-full font-sans text-text-main bg-surface border rounded-md px-3 py-2 pr-8 appearance-none transition-colors duration-200 ease-out focus:outline-none disabled:opacity-50 disabled:bg-bg cursor-pointer';
    
    const stateStyles = error 
      ? 'border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500' 
      : 'border-border focus:border-primary focus:ring-1 focus:ring-primary hover:border-primary/50';

    return (
      <div className="relative w-full">
        <select
          ref={ref}
          className={`${baseStyles} ${stateStyles} ${className}`}
          {...props}
        >
          {children}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-text-muted">
          <svg className="h-4 w-4 fill-current" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
            <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
          </svg>
        </div>
      </div>
    );
  }
);

Select.displayName = 'Select';
