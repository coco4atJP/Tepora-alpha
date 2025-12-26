import React, { useState, useEffect, useMemo } from 'react';
import { ChatMode } from '../types';
import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DialControlProps {
    currentMode: ChatMode;
    onModeChange: (mode: ChatMode) => void;
    onSettingsClick: () => void;
}

const DialControl: React.FC<DialControlProps> = ({ currentMode, onModeChange, onSettingsClick }) => {
    const [rotation, setRotation] = useState(0);
    const { t } = useTranslation();

    const MODES: { mode: ChatMode; label: string; angle: number }[] = useMemo(() => [
        { mode: 'direct', label: t('dial.chat'), angle: -45 },
        { mode: 'search', label: t('dial.search'), angle: 0 },
        { mode: 'agent', label: t('dial.agent'), angle: 45 },
    ], [t]);

    useEffect(() => {
        const targetMode = MODES.find((m) => m.mode === currentMode);
        if (targetMode) {
            setRotation(targetMode.angle);
        }
    }, [currentMode, MODES]); // Added MODES to deps though it's recreated every render (should be optimized but acceptable for now)

    const handleModeClick = (mode: ChatMode) => {
        onModeChange(mode);
    };

    return (
        <div className="relative w-64 h-64 flex items-center justify-center select-none scale-90">
            {/* Outer Glow */}
            <div className="absolute inset-0 rounded-full bg-gold-500/5 blur-3xl"></div>

            {/* Outer Ring / Labels */}
            <div className="absolute inset-0 rounded-full border border-gold-500/20 bg-coffee-900/40 backdrop-blur-sm shadow-[0_0_30px_rgba(0,0,0,0.5)]"></div>

            {/* Labels */}
            {MODES.map((m) => {
                const isSelected = currentMode === m.mode;

                let positionClass = '';
                if (m.mode === 'direct') positionClass = 'top-8 left-8 -rotate-45';
                if (m.mode === 'search') positionClass = 'top-3 left-1/2 -translate-x-1/2';
                if (m.mode === 'agent') positionClass = 'top-8 right-8 rotate-45';

                return (
                    <div
                        key={m.mode}
                        onClick={() => handleModeClick(m.mode)}
                        className={`absolute ${positionClass} cursor-pointer transition-all duration-500 ${isSelected ? 'text-gold-400 font-bold text-shadow-glow scale-110' : 'text-coffee-300/60 hover:text-coffee-200'
                            }`}
                    >
                        <span className="text-sm tracking-[0.2em] font-display font-bold">{m.label}</span>
                    </div>
                );
            })}

            {/* The Dial Knob */}
            <div
                className="w-40 h-40 rounded-full bg-gradient-to-br from-coffee-700 to-black shadow-[inset_0_2px_10px_rgba(255,255,255,0.1),0_10px_30px_rgba(0,0,0,0.5)] flex items-center justify-center relative transition-transform duration-700 cubic-bezier(0.34, 1.56, 0.64, 1) border border-white/5"
                style={{ transform: `rotate(${rotation}deg)` }}
            >
                {/* Metallic finish effect */}
                <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.05),transparent)]"></div>

                {/* Indicator Line */}
                <div className="absolute top-3 w-1.5 h-6 bg-gold-500 rounded-full shadow-[0_0_10px_rgba(255,215,0,0.8)]"></div>

                {/* Inner Circle (Settings Button) */}
                <button
                    onClick={(e) => {
                        e.stopPropagation(); // Prevent dial interaction
                        onSettingsClick();
                    }}
                    className="w-20 h-20 rounded-full bg-gradient-to-br from-gold-600/20 to-black shadow-inner flex items-center justify-center hover:scale-105 active:scale-95 transition-all group border border-gold-500/30 backdrop-blur-md relative overflow-hidden"
                    aria-label={t('common.settings')}
                >
                    <div className="absolute inset-0 bg-gold-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                    <Settings className="w-8 h-8 text-gold-200/80 group-hover:text-gold-100 group-hover:rotate-90 transition-all duration-700" />
                </button>

                {/* Ticks */}
                {[...Array(24)].map((_, i) => (
                    <div
                        key={i}
                        className={`absolute w-0.5 ${i % 2 === 0 ? 'h-2 bg-white/20' : 'h-1 bg-white/10'}`}
                        style={{
                            top: '6px',
                            left: '50%',
                            transformOrigin: '0 74px',
                            transform: `translateX(-50%) rotate(${i * 15}deg)`,
                        }}
                    />
                ))}
            </div>
        </div>
    );
};

export default DialControl;
