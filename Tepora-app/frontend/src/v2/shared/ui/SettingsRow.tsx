import React, { ReactNode } from 'react';

interface SettingsRowProps {
    label: string;
    description?: string;
    children: ReactNode;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({ label, description, children }) => {
    return (
        <div className="flex flex-col gap-4 transition-opacity duration-300 hover:opacity-100">
            <div className="flex justify-between items-baseline gap-4">
                <span className="text-[1.1rem] text-text-main font-light tracking-[0.02em]">{label}</span>
                {description && <span className="text-[0.85rem] text-text-muted font-light leading-[1.6] max-w-[80%] text-right">{description}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-8 mt-2">
                {children}
            </div>
        </div>
    );
};
