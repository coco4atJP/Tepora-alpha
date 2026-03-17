import React from 'react';

export interface SettingsViewProps {
  isOpen: boolean;
  onClose: () => void;
  activeSection: string;
  onSectionChange: (sectionId: string) => void;
  children?: React.ReactNode; // Right side content
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  isOpen,
  onClose,
  activeSection,
  onSectionChange,
  children,
}) => {
  const navItems = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'agents', label: 'Agents' },
    { id: 'advanced', label: 'Advanced' },
  ];

  return (
    <div
      className={`absolute inset-0 z-[60] bg-bg transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] flex pt-[8vh] px-[12vw] gap-[6vw] overflow-hidden ${
        isOpen
          ? 'opacity-100 pointer-events-auto translate-y-0'
          : 'opacity-0 pointer-events-none translate-y-5'
      }`}
    >
      {/* Header / Close Button */}
      <div className={`absolute top-10 right-10 z-[100] transition-all duration-400 delay-200 ${isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}>
        <button
          onClick={onClose}
          className="bg-transparent border-none text-text-muted text-base flex items-center gap-2 cursor-pointer transition-all duration-300 font-sans px-4 py-2 rounded-[20px] hover:text-text-main hover:bg-white/5 hover:-translate-x-1"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
          Close
        </button>
      </div>

      {/* Left Navigation */}
      <div className={`flex-[0_0_240px] flex flex-col gap-10 pt-5 transition-all duration-600 delay-100 ease-[cubic-bezier(0.16,1,0.3,1)] ${isOpen ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-5'}`}>
        <div className="flex flex-col gap-4">
          <div className="text-[0.7rem] uppercase tracking-[0.15em] text-primary/50 font-semibold mb-2">
            Settings
          </div>
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onSectionChange(item.id)}
              className={`font-serif text-[2rem] text-left transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] self-start ${
                activeSection === item.id
                  ? 'text-text-main text-[2.2rem] translate-x-3'
                  : 'text-text-muted hover:text-primary hover:translate-x-2'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Right Content */}
      <div className={`flex-1 max-w-[700px] pt-5 pb-[20vh] pr-5 flex flex-col gap-20 overflow-y-auto custom-scrollbar transition-all duration-600 delay-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
        {children}
      </div>
    </div>
  );
};
