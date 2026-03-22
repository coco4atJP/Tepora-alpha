import React, { ReactNode } from 'react';

interface SettingsSectionGroupProps {
    title?: string;
    children: ReactNode;
}

export const SettingsSectionGroup: React.FC<SettingsSectionGroupProps> = ({ title, children }) => {
    return (
        <div className="flex flex-col gap-4 mb-4">
            {title && (
                <h2 className="font-serif text-[1.25rem] text-gold mb-3 pb-2 border-b border-white/5 font-normal italic tracking-[0.05em]">
                    {title}
                </h2>
            )}
            <div className="flex flex-col gap-4">
                {children}
            </div>
        </div>
    );
};
