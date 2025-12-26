import React, { useState } from 'react';
import { User, ChevronUp, Check } from 'lucide-react';

interface Persona {
    id: string;
    name: string;
    avatar?: string;
    description: string;
}

const PERSONAS: Persona[] = [
    { id: 'default', name: 'Tepora', description: 'Standard Assistant' },
    { id: 'casual', name: 'Barista', description: 'Friendly & Warm' },
    { id: 'tech', name: 'Operator', description: 'Technical & Precise' },
];

interface PersonaSwitcherProps {
    currentPersonaId?: string;
    onPersonaChange: (personaId: string) => void;
}

const PersonaSwitcher: React.FC<PersonaSwitcherProps> = ({ currentPersonaId = 'default', onPersonaChange }) => {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 p-2 rounded-lg hover:bg-white/5 transition-colors text-coffee-100"
                title="Change Persona"
            >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-coffee-400 to-coffee-700 flex items-center justify-center border border-white/10 shadow-lg">
                    <User className="w-4 h-4 text-white" />
                </div>
                <ChevronUp className={`w-4 h-4 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-64 glass-panel rounded-xl overflow-hidden animate-fade-in z-50">
                    <div className="p-3 border-b border-white/5 bg-black/20">
                        <h3 className="text-xs font-bold text-coffee-200 uppercase tracking-wider">Select Persona</h3>
                    </div>
                    <div className="p-1">
                        {PERSONAS.map((persona) => (
                            <button
                                key={persona.id}
                                onClick={() => {
                                    onPersonaChange(persona.id);
                                    setIsOpen(false);
                                }}
                                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all ${currentPersonaId === persona.id
                                        ? 'bg-gold-500/20 border border-gold-500/30'
                                        : 'hover:bg-white/5 border border-transparent'
                                    }`}
                            >
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${currentPersonaId === persona.id ? 'bg-gold-500 text-black' : 'bg-coffee-800 text-coffee-200'
                                    }`}>
                                    {persona.name[0]}
                                </div>
                                <div className="text-left flex-1">
                                    <div className={`text-sm font-medium ${currentPersonaId === persona.id ? 'text-gold-300' : 'text-gray-200'}`}>
                                        {persona.name}
                                    </div>
                                    <div className="text-xs text-gray-400">{persona.description}</div>
                                </div>
                                {currentPersonaId === persona.id && <Check className="w-4 h-4 text-gold-400" />}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PersonaSwitcher;
