import React from 'react';
import { SettingsLayout } from '../view/SettingsLayout';

interface SettingsScreenProps {
    isOpen?: boolean;
    onClose?: () => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ isOpen = true, onClose = () => {} }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 bg-theme-bg">
            <SettingsLayout onClose={onClose} />
        </div>
    );
};
