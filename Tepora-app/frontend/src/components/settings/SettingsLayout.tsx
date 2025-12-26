import React, { ReactNode } from 'react';
import './settings.css';

interface SettingsLayoutProps {
    children: ReactNode;
}

export const SettingsLayout: React.FC<SettingsLayoutProps> = ({ children }) => {
    return (
        <div className="settings-layout">
            {children}
            {/* Ambient Background Elements */}
            <div className="pointer-events-none fixed -top-[20%] -right-[10%] w-[800px] h-[800px] bg-gold-400/5 rounded-full blur-3xl z-0" />
            <div className="pointer-events-none fixed -bottom-[20%] -left-[10%] w-[600px] h-[600px] bg-purple-500/5 rounded-full blur-3xl z-0" />
        </div>
    );
};
