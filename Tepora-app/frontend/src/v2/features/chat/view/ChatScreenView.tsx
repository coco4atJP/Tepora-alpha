import React from 'react';
import type { ChatScreenViewProps } from './props';
import { ChatMessageList } from './ChatMessageList';
import { CommandArea } from './CommandArea';

// Wrapper component to match the exact props definition from logic team
export const ChatScreenView: React.FC<
  ChatScreenViewProps & {
    onOpenSettings?: () => void;
    onAddAttachment?: () => void;
  }
> = ({
  messages,
  draft,
  onDraftChange,
  activeMode,
  onModeChange,
  composer,
  onSend,
  onStop,
  onRegenerate,
  onThinkingBudgetChange,
  onAddAttachment,
  onRemoveAttachment,
  onOpenSettings,
}) => {
  return (
    <div className="relative w-full h-full flex flex-col">
      <ChatMessageList messages={messages} isEmpty={messages.length === 0} />
      
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-full max-w-[800px] z-50 px-5">
        <CommandArea 
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onStop={onStop}
          activeMode={activeMode as any}
          onModeChange={onModeChange as any}
          composer={composer}
          onRegenerate={onRegenerate}
          onThinkingBudgetChange={onThinkingBudgetChange}
          onAddAttachment={onAddAttachment}
          onRemoveAttachment={onRemoveAttachment}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
};
