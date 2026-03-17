import React, { useState } from 'react';

// Using ChatMode from contracts instead of local Mode
// Since we don't have direct access to shared/contracts in this isolated view, we'll accept string
export type ChatModeType = 'chat' | 'search' | 'agent';

export interface RadialMenuProps {
  currentMode: ChatModeType;
  onModeChange: (mode: ChatModeType) => void;
  onOpenSettings?: () => void;
}

export const RadialMenu: React.FC<RadialMenuProps> = ({ currentMode, onModeChange, onOpenSettings }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div 
      className="relative w-11 h-11 flex items-center justify-center z-[100]"
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      {/* Collapsed State */}
      <div className={`w-11 h-11 rounded-full bg-gradient-to-br from-primary/10 to-secondary/10 border border-primary/30 flex items-center justify-center text-primary cursor-pointer transition-all duration-300 ${isExpanded ? 'scale-75 opacity-50' : 'scale-100 opacity-100'}`}>
        <span className="text-sm font-serif italic">
          {currentMode === 'chat' ? 'C' : currentMode === 'search' ? 'S' : 'A'}
        </span>
      </div>

      {/* Expanded Radial Menu */}
      <div className={`absolute top-1/2 left-1/2 w-[180px] h-[180px] -mt-[90px] -ml-[90px] rounded-full bg-bg/95 border border-white/5 shadow-[0_10px_40px_rgba(0,0,0,0.9),inset_0_0_20px_rgba(252,211,77,0.05)] backdrop-blur-md transition-all duration-400 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex items-center justify-center ${isExpanded ? 'opacity-100 scale-100 rotate-0 pointer-events-auto' : 'opacity-0 scale-50 -rotate-45 pointer-events-none'}`}>
        
        {/* Center Knob */}
        <div className="absolute w-11 h-11 rounded-full bg-gradient-to-br from-surface to-bg border border-white/10 flex items-center justify-center text-white/50 z-10 cursor-pointer hover:text-primary hover:scale-110 shadow-sm transition-all duration-200">
          <div className="w-1.5 h-1.5 rounded-full bg-current" />
        </div>

        {/* Menu Items */}
        <button 
          onClick={() => onModeChange('chat')}
          className={`absolute top-2 left-[68px] w-11 h-11 rounded-full flex flex-col items-center justify-center transition-all duration-200 border-none outline-none cursor-pointer group ${currentMode === 'chat' ? 'text-primary bg-primary/10 scale-110 shadow-[0_0_15px_rgba(252,211,77,0.2)]' : 'text-white/50 hover:text-primary hover:bg-primary/10 hover:scale-110'}`}
        >
          <span className="text-sm font-serif italic">C</span>
          <span className="absolute -bottom-5 text-[0.65rem] tracking-widest uppercase opacity-0 group-hover:opacity-100 group-hover:translate-y-1 transition-all duration-200 text-primary font-sans">Chat</span>
        </button>

        <button 
          onClick={() => onModeChange('search')}
          className={`absolute top-[68px] left-2 w-11 h-11 rounded-full flex flex-col items-center justify-center transition-all duration-200 border-none outline-none cursor-pointer group ${currentMode === 'search' ? 'text-primary bg-primary/10 scale-110 shadow-[0_0_15px_rgba(252,211,77,0.2)]' : 'text-white/50 hover:text-primary hover:bg-primary/10 hover:scale-110'}`}
        >
          <span className="text-sm font-serif italic">S</span>
          <span className="absolute -bottom-5 text-[0.65rem] tracking-widest uppercase opacity-0 group-hover:opacity-100 group-hover:translate-y-1 transition-all duration-200 text-primary font-sans">Search</span>
        </button>

        <button 
          onClick={() => onModeChange('agent')}
          className={`absolute top-[68px] right-2 w-11 h-11 rounded-full flex flex-col items-center justify-center transition-all duration-200 border-none outline-none cursor-pointer group ${currentMode === 'agent' ? 'text-primary bg-primary/10 scale-110 shadow-[0_0_15px_rgba(252,211,77,0.2)]' : 'text-white/50 hover:text-primary hover:bg-primary/10 hover:scale-110'}`}
        >
          <span className="text-sm font-serif italic">A</span>
          <span className="absolute -bottom-5 text-[0.65rem] tracking-widest uppercase opacity-0 group-hover:opacity-100 group-hover:translate-y-1 transition-all duration-200 text-primary font-sans">Agent</span>
        </button>

        <button 
          onClick={() => onOpenSettings?.()}
          className={`absolute bottom-2 left-[68px] w-11 h-11 rounded-full flex flex-col items-center justify-center transition-all duration-200 border-none outline-none cursor-pointer group text-white/50 hover:text-primary hover:bg-primary/10 hover:scale-110`}
        >
          <span className="text-sm">⚙</span>
          <span className="absolute -bottom-5 text-[0.65rem] tracking-widest uppercase opacity-0 group-hover:opacity-100 group-hover:translate-y-1 transition-all duration-200 text-primary font-sans">Set</span>
        </button>

      </div>
    </div>
  );
};
