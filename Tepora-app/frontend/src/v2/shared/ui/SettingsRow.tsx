import React, { ReactNode } from 'react';

interface SettingsRowProps {
    label: string;
    description?: string;
    children: ReactNode;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({ label, description, children }) => {
    return (
        <div className="flex flex-col gap-3 py-4">
            <div className="flex flex-col gap-1">
                <span className="font-sans text-sm tracking-widest text-theme-text uppercase opacity-80">{label}</span>
                {description && <span className="font-sans text-xs text-theme-subtext">{description}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-6">
                {children}
            </div>
        </div>
    );
};
