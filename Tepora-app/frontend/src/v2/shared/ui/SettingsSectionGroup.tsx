import React, { ReactNode } from 'react';

interface SettingsSectionGroupProps {
    title?: string;
    children: ReactNode;
}

export const SettingsSectionGroup: React.FC<SettingsSectionGroupProps> = ({ title, children }) => {
    return (
        <div className="flex flex-col gap-8 mb-24">
            {title && (
                <h3 className="font-display text-2xl text-gold-500 italic font-light tracking-wide">{title}</h3>
            )}
            <div className="flex flex-col gap-4">
                {children}
            </div>
        </div>
    );
};
