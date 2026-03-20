import React from 'react';

interface LineSliderProps {
    min: number;
    max: number;
    step?: number;
    value: number;
    onChange: (value: number) => void;
    label?: string;
    unit?: string;
}

export const LineSlider: React.FC<LineSliderProps> = ({ min, max, step = 1, value, onChange, label, unit }) => {
    return (
        <div className="flex flex-col gap-2 w-full max-w-[240px] group">
            {(label || unit) && (
                <div className="flex justify-between items-end font-sans text-sm tracking-wide">
                    {label && <span className="text-theme-subtext group-hover:text-theme-text transition-colors">{label}</span>}
                    <span className="text-gold-500 tabular-nums">
                        {value}{unit}
                    </span>
                </div>
            )}
            <div className="relative flex items-center h-4 cursor-pointer group/slider">
                {/* Invisible input overlay */}
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => onChange(parseFloat(e.target.value))}
                    className="absolute w-full h-full opacity-0 cursor-pointer z-10"
                />
                {/* Track */}
                <div className="w-full h-[1px] bg-theme-border overflow-hidden rounded-full">
                    <div
                        className="h-full bg-gold-500/30 transition-all duration-75"
                        style={{ width: `${((value - min) / (max - min)) * 100}%` }}
                    />
                </div>
                {/* Knob */}
                <div
                    className="absolute w-2 h-2 rounded-full bg-gold-500 shadow-[0_0_8px_rgba(212,191,128,0.5)] pointer-events-none transition-all duration-75 group-hover/slider:scale-150"
                    style={{ left: `calc(${((value - min) / (max - min)) * 100}% - 4px)` }}
                />
            </div>
        </div>
    );
};
