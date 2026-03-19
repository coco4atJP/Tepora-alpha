import React from 'react';

interface MinToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
}

export const MinToggle: React.FC<MinToggleProps> = ({ checked, onChange, label }) => {
    return (
        <label className="flex items-center gap-4 cursor-pointer group" onClick={(e) => { e.preventDefault(); onChange(!checked); }}>
            <div className="relative flex items-center">
                {/* Track */}
                <div className={`w-8 h-[2px] transition-colors duration-300 ${checked ? 'bg-gold-500/50' : 'bg-theme-border'}`} />
                {/* Knob */}
                <div className={`absolute w-3 h-3 rounded-full transition-all duration-300 shadow-md ${
                    checked ? 'bg-gold-500 left-5 shadow-[0_0_8px_rgba(212,191,128,0.5)]' : 'bg-theme-subtext left-0'
                }`} />
            </div>
            {label && (
                <span className={`font-sans text-sm tracking-wide transition-colors duration-300 ${checked ? 'text-theme-text' : 'text-theme-subtext group-hover:text-theme-text'}`}>
                    {label}
                </span>
            )}
        </label>
    );
};
