import React from 'react';

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  ({ className = '', error, ...props }, ref) => {
    const baseStyles = 'block w-full font-sans text-text-main bg-surface border rounded-md px-3 py-2 transition-colors duration-200 ease-out focus:outline-none disabled:opacity-50 disabled:bg-bg';
    
    // Normal: border-border. Focus: border-primary ring-1 ring-primary
    const stateStyles = error 
      ? 'border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500' 
      : 'border-border focus:border-primary focus:ring-1 focus:ring-primary';

    return (
      <input
        ref={ref}
        className={`${baseStyles} ${stateStyles} ${className}`}
        {...props}
      />
    );
  }
);

TextField.displayName = 'TextField';
