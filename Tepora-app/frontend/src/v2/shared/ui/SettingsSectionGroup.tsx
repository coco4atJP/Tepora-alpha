import React, { ReactNode } from 'react';

interface SettingsSectionGroupProps {
    title?: string;
    children: ReactNode;
}

export const SettingsSectionGroup: React.FC<SettingsSectionGroupProps> = ({ title, children }) => {
    return (
        <div className="flex flex-col gap-[40px] mb-8">
            {title && (
                <h2 className="font-serif text-[1.5rem] text-gold mb-6 pb-3 border-b border-white/5 font-normal italic tracking-[0.05em]">
                    {title}
                </h2>
            )}
            <div className="flex flex-col gap-6">
                {children}
            </div>
        </div>
    );
};
