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
      primary: 'bg-gradient-to-r from-gold-500 to-gold-400 text-black hover:brightness-110 active:scale-[0.98] shadow-[0_0_15px_rgba(217,119,6,0.2)] hover:shadow-[0_0_20px_rgba(217,119,6,0.3)]',
      secondary: 'bg-white/5 border border-white/10 text-gold-200 hover:bg-white/10 active:scale-[0.98]',
      ghost: 'bg-transparent border border-transparent text-gray-400 hover:text-white hover:bg-white/5 active:scale-[0.98]',
    };

    const widthStyles = fullWidth ? 'w-full shadow-lg' : '';

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
