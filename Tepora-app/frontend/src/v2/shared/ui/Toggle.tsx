import React from 'react';

export interface ToggleProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export const Toggle = React.forwardRef<HTMLInputElement, ToggleProps>(
  ({ className = '', label, checked, ...props }, ref) => {
    return (
      <label className={`inline-flex items-center cursor-pointer gap-3 ${className}`}>
        <div className="relative">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={checked}
            ref={ref}
            {...props}
          />
          <div className="w-9 h-5 bg-border rounded-full peer peer-focus:ring-2 peer-focus:ring-primary/50 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary transition-colors duration-300"></div>
        </div>
        {label && (
          <span className="text-sm font-sans text-text-main select-none">{label}</span>
        )}
      </label>
    );
  }
);

Toggle.displayName = 'Toggle';
