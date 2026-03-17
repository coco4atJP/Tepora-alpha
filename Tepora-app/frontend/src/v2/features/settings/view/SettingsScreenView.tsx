import React from 'react';
import type { SettingsScreenViewProps } from './props';
import { SettingsView } from './SettingsView';
import { Toggle } from '../../../shared/ui/Toggle';
import { TextField } from '../../../shared/ui/TextField';
import { Select } from '../../../shared/ui/Select';

export interface SettingsScreenViewWrapperProps extends SettingsScreenViewProps {
  isOpen: boolean;
  onClose: () => void;
  activeSectionId: string;
  onSectionChange: (id: string) => void;
}

export const SettingsScreenView: React.FC<SettingsScreenViewWrapperProps> = ({
  isOpen,
  onClose,
  activeSectionId,
  onSectionChange,
  sections,
  onFieldChange,
  onSave,
  state,
  errorMessage,
}) => {
  
  const activeSection = sections.find(s => s.id === activeSectionId) || sections[0];

  return (
    <SettingsView
      isOpen={isOpen}
      onClose={onClose}
      activeSection={activeSectionId}
      onSectionChange={onSectionChange}
    >
      {activeSection && (
        <div className="flex flex-col gap-10">
          <div className="font-serif text-[1.5rem] text-primary mb-6 pb-3 border-b border-white/5 font-normal italic tracking-[0.05em]">
            {activeSection.title}
          </div>
          
          {activeSection.description && (
            <p className="text-text-muted text-sm -mt-4 mb-4 leading-relaxed font-light">
              {activeSection.description}
            </p>
          )}

          <div className="flex flex-col gap-8">
            {activeSection.fields.map(field => (
              <div key={field.id} className="flex flex-col gap-3">
                <div className="flex justify-between items-start gap-4">
                  <div className="flex flex-col">
                    <label className="text-text-main font-medium">{field.label}</label>
                    {field.description && (
                      <span className="text-text-muted text-sm font-light mt-1">{field.description}</span>
                    )}
                  </div>
                  
                  <div className="min-w-[200px] flex justify-end">
                    {field.kind === 'toggle' && (
                      <Toggle 
                        checked={field.value as boolean} 
                        onChange={(e) => onFieldChange(field.id, e.target.checked)} 
                      />
                    )}
                    {field.kind === 'text' && (
                      <TextField 
                        value={(field.value as string) || ''} 
                        onChange={(e) => onFieldChange(field.id, e.target.value)} 
                        placeholder={field.label}
                      />
                    )}
                    {field.kind === 'number' && (
                      <TextField 
                        type="number"
                        value={(field.value as number) || 0} 
                        onChange={(e) => onFieldChange(field.id, Number(e.target.value))} 
                      />
                    )}
                    {field.kind === 'select' && field.options && (
                      <Select 
                        value={(field.value as string) || ''} 
                        onChange={(e) => onFieldChange(field.id, e.target.value)}
                      >
                        {field.options.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10 pt-6 border-t border-white/5 flex items-center justify-between">
            {errorMessage ? (
              <div className="text-red-400 text-sm">{errorMessage}</div>
            ) : (
              <div className="text-text-muted text-sm opacity-50">
                {state === 'saving' ? 'Saving...' : state === 'ready' ? 'All changes saved.' : ''}
              </div>
            )}
            
            <button
              onClick={onSave}
              disabled={state === 'saving' || state === 'loading'}
              className="bg-primary text-[#FAFAFA] px-6 py-2 rounded-full text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              Save Changes
            </button>
          </div>
        </div>
      )}
    </SettingsView>
  );
};
