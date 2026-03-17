import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', fullWidth, children, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center font-sans font-medium transition-colors duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
    
    // Size is standard, rounded-md
    const sizeStyles = 'px-4 py-2 text-sm rounded-md';
    
    const variantStyles = {
      primary: 'bg-primary text-[#FAFAFA] hover:opacity-90 border border-transparent', // Assuming #FAFAFA for inverse text
      secondary: 'bg-transparent border border-secondary text-secondary hover:bg-secondary/10',
      ghost: 'bg-transparent border border-transparent text-text-main hover:bg-surface/50',
    };

    const widthStyles = fullWidth ? 'w-full' : '';

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${sizeStyles} ${variantStyles[variant]} ${widthStyles} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
