import React from 'react';
import type { SessionSidebarViewProps } from './props';

export const SessionSidebarView: React.FC<SessionSidebarViewProps> = ({
  state,
  sessions,
  errorMessage,
  onSelectSession,
  onCreateSession,
}) => {
  return (
    <div className="flex flex-col h-full overflow-hidden text-text-main">
      <div className="flex items-center justify-between mb-10">
        <div className="font-serif text-[1.8rem] text-primary tracking-[0.08em] italic">
          History
        </div>
      </div>

      <button
        onClick={onCreateSession}
        disabled={state === 'loading'}
        className="w-full bg-transparent border border-primary/30 text-primary py-3 px-5 rounded-[30px] text-[0.95rem] cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] flex items-center justify-center gap-3 mb-10 hover:bg-primary/5 hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(252,211,77,0.1)] disabled:opacity-50"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        New Session
      </button>

      {errorMessage && (
        <div className="text-red-400 text-sm mb-4 px-2">{errorMessage}</div>
      )}

      <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-2 -mr-2 custom-scrollbar">
        {state === 'loading' && sessions.length === 0 ? (
          <div className="text-text-muted text-sm px-4">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="text-text-muted text-sm px-4 opacity-50">No history found.</div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`p-3 px-4 rounded-xl text-[0.9rem] cursor-pointer transition-all duration-300 font-light tracking-[0.02em] ${
                session.isSelected
                  ? 'bg-white/5 text-text-main font-normal'
                  : 'text-text-muted hover:bg-white/5 hover:text-text-main hover:translate-x-1'
              }`}
            >
              <div className="font-sans mb-1 truncate">{session.title}</div>
              {session.preview && (
                <div className="text-[0.75rem] opacity-60 truncate">{session.preview}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
