import React from 'react';

interface SelectionDotProps {
    label: string;
    selected: boolean;
    onClick: () => void;
}

export const SelectionDot: React.FC<SelectionDotProps> = ({ label, selected, onClick }) => {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-3 transition-colors duration-300 group ${
                selected ? 'text-gold-500' : 'text-theme-subtext hover:text-theme-text'
            }`}
        >
            <div className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                selected ? 'bg-gold-500 scale-100 shadow-[0_0_8px_rgba(212,191,128,0.5)]' : 'bg-transparent scale-0'
            }`} />
            <span className="font-sans text-sm tracking-wide">{label}</span>
        </button>
    );
};
