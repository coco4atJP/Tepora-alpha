import React, { useState } from 'react';
import { ChevronDown, Plus, Trash2, Cpu, Users, Check } from 'lucide-react';

export interface NavItem {
    id: string;
    label: string;
    icon: React.ReactNode;
}

// ============================================================================
// Base Form Components
// ============================================================================

interface FormGroupProps {
    label: string;
    description?: string;
    children: React.ReactNode;
    error?: string;
}

export const FormGroup: React.FC<FormGroupProps> = ({ label, description, children, error }) => (
    <div className="settings-form-group">
        <div className="settings-form-group__header">
            <label className="settings-form-group__label">{label}</label>
            {description && <p className="settings-form-group__description">{description}</p>}
        </div>
        <div className="settings-form-group__content">
            {children}
        </div>
        {error && <p className="settings-form-group__error">{error}</p>}
    </div>
);

interface FormInputProps {
    value: string | number;
    onChange: (value: string | number) => void;
    type?: 'text' | 'number';
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    className?: string; // Additional classes
}

export const FormInput: React.FC<FormInputProps> = ({
    value,
    onChange,
    type = 'text',
    placeholder,
    min,
    max,
    step,
    disabled = false,
    className
}) => (
    <input
        type={type}
        value={value}
        onChange={(e) => onChange(type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className={`settings-input ${className || ''}`}
    />
);

interface FormSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

export const FormSwitch: React.FC<FormSwitchProps> = ({ checked, onChange, disabled = false }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={`settings-switch ${checked ? 'settings-switch--active' : ''} ${disabled ? 'settings-switch--disabled' : ''}`}
    >
        <span className="settings-switch__thumb" />
    </button>
);

interface FormSelectProps {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
    disabled?: boolean;
}

export const FormSelect: React.FC<FormSelectProps> = ({ value, onChange, options, disabled = false }) => (
    <div className="settings-select-wrapper">
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="settings-select"
        >
            {options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                    {opt.label}
                </option>
            ))}
        </select>
        <ChevronDown className="settings-select__icon" size={16} />
    </div>
);

interface FormListProps {
    items: string[];
    onChange: (items: string[]) => void;
    placeholder?: string;
}

export const FormList: React.FC<FormListProps> = ({ items, onChange, placeholder = 'Add item...' }) => {
    const [newItem, setNewItem] = useState('');

    const handleAdd = () => {
        if (newItem.trim()) {
            onChange([...items, newItem.trim()]);
            setNewItem('');
        }
    };

    const handleRemove = (index: number) => {
        onChange(items.filter((_, i) => i !== index));
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAdd();
        }
    };

    return (
        <div className="settings-list">
            <div className="settings-list__items">
                {items.map((item, index) => (
                    <div key={index} className="settings-list__item">
                        <code className="settings-list__item-text">{item}</code>
                        <button
                            type="button"
                            onClick={() => handleRemove(index)}
                            className="settings-list__item-remove"
                            aria-label="Remove item"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}
            </div>
            <div className="settings-list__add">
                <input
                    type="text"
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="settings-input settings-list__add-input"
                />
                <button type="button" onClick={handleAdd} className="settings-list__add-button" aria-label="Add item">
                    <Plus size={16} />
                </button>
            </div>
        </div>
    );
};

// ============================================================================
// Layout Components
// ============================================================================

interface SettingsSidebarProps {
    items: NavItem[];
    activeItem: string;
    onSelect: (id: string) => void;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({ items, activeItem, onSelect }) => {
    return (
        <aside className="settings-sidebar">
            <div className="settings-sidebar__header">
                TEPORA
            </div>
            <nav>
                <ul className="settings-sidebar__nav">
                    {items.map((item) => (
                        <li key={item.id}>
                            <button
                                onClick={() => onSelect(item.id)}
                                className={`settings-sidebar__item ${activeItem === item.id ? 'settings-sidebar__item--active' : ''}`}
                            >
                                {item.icon}
                                {item.label}
                            </button>
                        </li>
                    ))}
                </ul>
            </nav>
        </aside>
    );
};

// ============================================================================
// Card Components
// ============================================================================

interface ModelConfig {
    path: string;
    port: number;
    n_ctx: number;
    n_gpu_layers: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    logprobs?: boolean;
}

export const ModelCard: React.FC<{
    name: string;
    config: ModelConfig;
    onChange: (c: ModelConfig) => void;
    isEmbedding?: boolean;
}> = ({ name, config, onChange, isEmbedding }) => {
    const update = <K extends keyof ModelConfig>(f: K, v: ModelConfig[K]) => onChange({ ...config, [f]: v });

    return (
        <div className="settings-model-card">
            <div className="settings-model-card__header">
                <Cpu size={18} className="text-purple-400" />
                <h3 className="settings-model-card__title">{name}</h3>
            </div>
            <div className="settings-model-card__grid">
                <FormGroup label="Path">
                    <FormInput value={config.path} onChange={(v) => update('path', v as string)} placeholder="models/*.gguf" className="font-mono text-xs" />
                </FormGroup>
                <FormGroup label="Port">
                    <FormInput type="number" value={config.port} onChange={(v) => update('port', v as number)} />
                </FormGroup>
                <FormGroup label="Context">
                    <FormInput type="number" value={config.n_ctx} onChange={(v) => update('n_ctx', v as number)} step={512} />
                </FormGroup>
                <FormGroup label="GPU Layers">
                    <FormInput type="number" value={config.n_gpu_layers} onChange={(v) => update('n_gpu_layers', v as number)} min={-1} />
                </FormGroup>

                {!isEmbedding && (
                    <>
                        <FormGroup label="Temp">
                            <FormInput type="number" value={config.temperature ?? 0.7} onChange={(v) => update('temperature', v as number)} step={0.1} />
                        </FormGroup>
                        <FormGroup label="Top P">
                            <FormInput type="number" value={config.top_p ?? 0.9} onChange={(v) => update('top_p', v as number)} step={0.05} />
                        </FormGroup>
                    </>
                )}
            </div>
        </div>
    );
};

interface AgentProfile {
    label: string;
    description: string;
    persona: {
        key?: string;
        prompt?: string;
    };
    tool_policy: {
        allow: string[];
        deny: string[];
    };
}

export const AgentCard: React.FC<{
    id: string;
    profile: AgentProfile;
    onChange: (p: AgentProfile) => void;
    isActive: boolean;
    onSetActive: () => void;
}> = ({ id, profile, onChange, isActive, onSetActive }) => {
    const updateField = <K extends keyof AgentProfile>(field: K, value: AgentProfile[K]) => {
        onChange({ ...profile, [field]: value });
    };

    const updatePersona = (field: 'key' | 'prompt', value: string) => {
        onChange({ ...profile, persona: { ...profile.persona, [field]: value } });
    };

    return (
        <div className={`settings-agent-card ${isActive ? 'settings-agent-card--active' : ''}`}>
            <div className="settings-agent-card__header">
                <div className="flex items-center gap-2 flex-1">
                    <Users size={18} className="text-gold-400" />
                    <h3 className="settings-agent-card__title">{profile.label || id}</h3>
                </div>
                <button
                    type="button"
                    onClick={onSetActive}
                    className={`settings-agent-card__active-btn ${isActive ? 'settings-agent-card__active-btn--active' : ''}`}
                    title={isActive ? 'Currently Active' : 'Set as Active'}
                >
                    {isActive && <Check size={14} />}
                    {isActive ? 'Active' : 'Set Active'}
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <FormGroup label="Label">
                    <FormInput
                        value={profile.label}
                        onChange={(v) => updateField('label', v as string)}
                        placeholder="Agent Name"
                    />
                </FormGroup>
                <FormGroup label="Description">
                    <FormInput
                        value={profile.description}
                        onChange={(v) => updateField('description', v as string)}
                        placeholder="Short description"
                    />
                </FormGroup>
            </div>

            <FormGroup label="Persona" description="Define the agent's personality and role.">
                <div className="space-y-3">
                    <div className="grid grid-cols-[120px_1fr] gap-4 items-center">
                        <span className="text-sm text-gray-400">Preset Key</span>
                        <FormInput
                            value={profile.persona.key || ''}
                            onChange={(v) => updatePersona('key', v as string)}
                            placeholder="e.g. default (Optional)"
                            className="font-mono text-sm"
                        />
                    </div>
                    <div>
                        <span className="text-sm text-gray-400 mb-1 block">Custom Prompt (Override)</span>
                        <textarea
                            value={profile.persona.prompt || ''}
                            onChange={(e) => updatePersona('prompt', e.target.value)}
                            className="settings-input settings-input--textarea w-full font-sans leading-relaxed text-sm p-3 bg-black/20 rounded border border-white/10"
                            rows={3}
                            placeholder="You are a helpful AI assistant..."
                        />
                    </div>
                </div>
            </FormGroup>

            <div className="mt-4 pt-4 border-t border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FormGroup label="Allowed Tools" description='Use "*" for all.'>
                        <FormList
                            items={profile.tool_policy.allow}
                            onChange={(items) => onChange({ ...profile, tool_policy: { ...profile.tool_policy, allow: items } })}
                            placeholder="Tool name..."
                        />
                    </FormGroup>
                    <FormGroup label="Denied Tools">
                        <FormList
                            items={profile.tool_policy.deny}
                            onChange={(items) => onChange({ ...profile, tool_policy: { ...profile.tool_policy, deny: items } })}
                            placeholder="Tool name..."
                        />
                    </FormGroup>
                </div>
            </div>
        </div>
    );
};

// ============================================================================
// Section Components
// ============================================================================

interface SettingsSectionProps {
    title: string;
    icon?: React.ReactNode;
    children: React.ReactNode;
    description?: string;
    className?: string; // For staggered animation delays
    style?: React.CSSProperties;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({ title, icon, children, description, className, style }) => (
    <section className={`settings-section ${className || ''}`} style={style}>
        <div className="settings-section__header">
            {icon && <span className="settings-section__icon">{icon}</span>}
            <h2 className="settings-section__title">{title}</h2>
        </div>
        {description && <p className="settings-section__description">{description}</p>}
        {/* Removed wrapper to allow freer layout, children should handle grids if needed */}
        {children}
    </section>
);
