import React from 'react';
import type { AgentPanelViewProps } from './props';
import { Chip } from '../../../shared/ui/Chip';

export const AgentPanelView: React.FC<AgentPanelViewProps> = ({
  state,
  sections,
  activeContext,
  toolConfirmation,
  errorMessage,
  onToolDecision,
}) => {
  return (
    <div className="flex flex-col h-full overflow-hidden text-text-main">
      <div className="flex items-center gap-3 text-primary font-serif text-[1.3rem] mb-10 pb-4 border-b border-white/5 italic">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
        </svg>
        Context Control
      </div>

      {errorMessage && (
        <div className="text-red-400 text-sm mb-4 px-2">{errorMessage}</div>
      )}

      <div className="flex-1 overflow-y-auto flex flex-col pr-2 -mr-2 custom-scrollbar pb-10">
        
        {/* Active Context Chips */}
        {activeContext.length > 0 && (
          <div className="mb-8">
            <div className="text-[0.7rem] text-primary/50 uppercase tracking-[0.1em] mb-4 font-semibold">Active Context</div>
            <div className="flex flex-wrap gap-2">
              {activeContext.map(ctx => (
                <Chip key={ctx.id} active={ctx.kind === 'agent'}>
                  {ctx.label}
                </Chip>
              ))}
            </div>
          </div>
        )}

        {toolConfirmation && (
          <div className="mb-8">
            <div className="text-[0.7rem] text-primary/50 uppercase tracking-[0.1em] mb-4 font-semibold">Approval Required</div>
            <div className="bg-surface/10 border border-primary/20 p-4 rounded-2xl text-sm text-text-muted leading-relaxed font-light">
              <div className="text-text-main font-medium">{toolConfirmation.toolName}</div>
              <div className="mt-2 text-xs uppercase tracking-[0.1em] text-primary/70">
                {toolConfirmation.riskLevel} risk
              </div>
              {toolConfirmation.description && (
                <p className="mt-3">{toolConfirmation.description}</p>
              )}
              <p className="mt-3">{toolConfirmation.scopeLabel}</p>
              <pre className="mt-3 max-h-40 overflow-auto rounded-xl bg-black/30 p-3 text-xs text-text-main/80">{toolConfirmation.argsPreview}</pre>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void onToolDecision("deny")}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-text-main transition-colors hover:border-primary/30 hover:text-primary"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => void onToolDecision("once")}
                  className="rounded-full border border-primary/25 px-3 py-1.5 text-xs text-primary transition-colors hover:border-primary/40"
                >
                  Approve once
                </button>
                {toolConfirmation.expiryOptions[0] ? (
                  <button
                    type="button"
                    onClick={() =>
                      void onToolDecision(
                        "always_until_expiry",
                        toolConfirmation.expiryOptions[0],
                      )
                    }
                    className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-text-main transition-colors hover:border-primary/30 hover:text-primary"
                  >
                    Allow temporarily
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {/* Dynamic Sections from logic */}
        {sections.map(section => (
          <div key={section.id} className="mb-8">
            <div className="text-[0.7rem] text-primary/50 uppercase tracking-[0.1em] mb-4 font-semibold">{section.title}</div>
            <div className="bg-surface/5 border border-white/5 p-4 rounded-2xl text-sm text-text-muted leading-relaxed font-light">
              {/* For simplicity, treating body as text. In real app, might be structured options. */}
              {section.body}
            </div>
          </div>
        ))}
        
        {state === 'loading' && (
          <div className="text-text-muted text-sm opacity-50 mt-4">Syncing...</div>
        )}
      </div>
    </div>
  );
};
