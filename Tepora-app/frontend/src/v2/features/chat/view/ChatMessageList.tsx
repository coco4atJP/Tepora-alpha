import React from 'react';
import type { ChatMessageViewModel } from './props';

export interface ChatMessageListProps {
  messages: ChatMessageViewModel[];
  isEmpty: boolean;
}

export const ChatMessageList: React.FC<ChatMessageListProps> = ({ messages, isEmpty }) => {
  return (
    <div className="flex-1 h-full overflow-y-auto px-5 pt-[60px] pb-[140px] flex flex-col items-center gap-12 custom-scrollbar">
      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50">
          <div className="font-serif text-3xl text-primary mb-4 italic">Tepora</div>
          <div className="text-text-muted text-sm tracking-widest uppercase">How can I assist you today?</div>
        </div>
      ) : (
        messages.map((msg) => (
          <div
            key={msg.id}
            className={`w-full max-w-[760px] flex gap-6 text-lg leading-relaxed animate-slide-up group/message relative ${
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            {/* Hover Actions (D-204) */}
            <div className={`absolute top-0 -mt-2 flex gap-2 opacity-0 group-hover/message:opacity-100 transition-opacity duration-200 z-10 ${msg.role === 'user' ? 'right-0 -translate-y-full' : 'right-0'}`}>
              <button className="p-1.5 text-text-muted hover:text-primary bg-surface/50 rounded-md backdrop-blur-sm transition-colors" title="Copy">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              {msg.role === 'user' ? (
                <button className="p-1.5 text-text-muted hover:text-primary bg-surface/50 rounded-md backdrop-blur-sm transition-colors" title="Edit">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                </button>
              ) : (
                <button className="p-1.5 text-text-muted hover:text-primary bg-surface/50 rounded-md backdrop-blur-sm transition-colors" title="Regenerate">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                </button>
              )}
            </div>

            {msg.role === 'user' ? (
              <div className="bg-surface/5 px-6 py-4 rounded-[20px] text-text-muted font-light tracking-wide shadow-sm">
                {msg.content}
              </div>
            ) : (
              <div className="flex flex-col w-full">
                <div className="font-serif text-primary text-xl mb-3 flex items-center gap-3 italic">
                  {msg.agentName || 'Tepora'}
                  {msg.mode && msg.mode !== 'chat' && (
                    <span className="text-[0.6rem] font-sans not-italic uppercase tracking-widest bg-secondary/10 text-secondary px-2 py-0.5 rounded-full border border-secondary/20">
                      {msg.mode}
                    </span>
                  )}
                  {msg.status === 'streaming' && (
                    <span className="flex gap-1 ml-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </span>
                  )}
                </div>
                <div className="pl-5 border-l border-primary/20 text-text-main flex flex-col gap-3">
                  {msg.thinking && (
                    <details className="text-sm text-text-muted mb-2 group cursor-pointer">
                      <summary className="opacity-70 hover:opacity-100 transition-opacity outline-none select-none flex items-center gap-2">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>
                        Thinking Process...
                      </summary>
                      <div className="mt-2 pl-4 border-l border-border/50 text-xs whitespace-pre-wrap font-mono">
                        {msg.thinking}
                      </div>
                    </details>
                  )}
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
};
