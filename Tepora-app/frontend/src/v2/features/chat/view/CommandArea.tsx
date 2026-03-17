import React from 'react';
import { RadialMenu, ChatModeType } from './RadialMenu';
import type { ChatComposerAttachmentViewModel } from './props';

export interface CommandAreaProps {
  draft: string;
  onDraftChange: (val: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRegenerate: () => void;
  activeMode: ChatModeType;
  onModeChange: (mode: ChatModeType) => void;
  onOpenSettings?: () => void;
  onAddAttachment?: () => void;
  composer: {
    attachments: ChatComposerAttachmentViewModel[];
    thinkingBudget: number;
    canSend: boolean;
    canStop: boolean;
    canRegenerate: boolean;
    isSending: boolean;
  };
  onThinkingBudgetChange: (value: number) => void;
  onRemoveAttachment: (attachmentId: string) => void;
}

export const CommandArea: React.FC<CommandAreaProps> = ({
  draft,
  onDraftChange,
  onSend,
  onStop,
  onRegenerate,
  activeMode,
  onModeChange,
  onOpenSettings,
  onAddAttachment,
  composer,
  onThinkingBudgetChange,
  onRemoveAttachment,
}) => {
  return (
    <div className="bg-surface/75 border border-border/30 rounded-[24px] shadow-[0_30px_60px_rgba(0,0,0,0.6)] backdrop-blur-[30px] flex flex-col p-4 px-6 transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] focus-within:border-primary/20 focus-within:shadow-[0_30px_60px_rgba(0,0,0,0.8),0_0_40px_rgba(189,75,38,0.1)] focus-within:-translate-y-0.5">
      
      {/* Attachments Area */}
      {composer.attachments.length > 0 && (
        <div className="flex gap-2 mb-3 pl-[60px] overflow-x-auto custom-scrollbar">
          {composer.attachments.map(att => (
            <div key={att.id} className="relative flex items-center gap-2 bg-surface/50 border border-border px-3 py-1.5 rounded-lg text-xs group">
              <span className="truncate max-w-[150px]">{att.name}</span>
              <button 
                onClick={() => onRemoveAttachment(att.id)}
                className="opacity-50 hover:opacity-100 text-text-muted hover:text-primary transition-opacity"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4">
        {/* Dial UI */}
        <RadialMenu 
          currentMode={activeMode} 
          onModeChange={onModeChange} 
          onOpenSettings={onOpenSettings}
        />
        
        {/* Input */}
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (composer.canSend) onSend();
            }
          }}
          placeholder="Type here..."
          rows={1}
          style={{ minHeight: '32px', maxHeight: '200px' }}
          className="flex-1 bg-transparent border-none outline-none text-[1.15rem] text-text-main font-sans py-2 placeholder:text-text-muted/50 placeholder:font-light peer resize-none overflow-y-auto custom-scrollbar"
        />
        
        {/* Send / Stop Button */}
        {composer.isSending || composer.canStop ? (
           <button
            onClick={onStop}
            className="w-11 h-11 rounded-full bg-secondary/10 border border-secondary/20 text-secondary cursor-pointer flex items-center justify-center transition-all duration-300 hover:bg-secondary/20 focus:outline-none"
            title="Stop Generation"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect>
            </svg>
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!composer.canSend}
            className="w-11 h-11 rounded-full bg-transparent border-none text-text-muted/50 cursor-pointer flex items-center justify-center transition-all duration-300 disabled:opacity-50 peer-focus:text-primary hover:bg-primary/10 hover:text-primary focus:outline-none"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        )}
      </div>

      {/* Footer Tools */}
      <div className="flex justify-between items-center pt-2 pl-[60px] border-t border-dashed border-white/5 mt-2">
        <div className="flex gap-4">
          <button 
            onClick={() => onThinkingBudgetChange(composer.thinkingBudget > 0 ? 0 : 1)}
            className={`bg-transparent border-none text-xs flex items-center gap-1.5 cursor-pointer transition-colors duration-200 font-sans ${composer.thinkingBudget > 0 ? 'text-primary' : 'text-text-muted hover:text-text-main'}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>
            Thinking: {composer.thinkingBudget > 0 ? 'On' : 'Off'}
          </button>
          <button
            onClick={onRegenerate}
            disabled={!composer.canRegenerate}
            className="bg-transparent border-none text-text-muted text-xs flex items-center gap-1.5 cursor-pointer transition-colors duration-200 hover:text-text-main font-sans disabled:opacity-40"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 2v6h6"></path><path d="M21 12A9 9 0 0 0 6 5.3L3 8"></path><path d="M21 22v-6h-6"></path><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"></path></svg>
            Regenerate
          </button>
          <button
            onClick={onAddAttachment}
            className="bg-transparent border-none text-text-muted text-xs flex items-center gap-1.5 cursor-pointer transition-colors duration-200 hover:text-text-main font-sans"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
            Attach
          </button>
        </div>
        <div className="text-[0.7rem] text-text-muted/40 font-mono">
          Enter to send
        </div>
      </div>
    </div>
  );
};
