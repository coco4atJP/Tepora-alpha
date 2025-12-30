import { render, fireEvent } from '@testing-library/react';
import { screen } from '@testing-library/dom';
import PersonaSwitcher from '../PersonaSwitcher';
import { describe, it, expect, vi } from 'vitest';
import { SettingsContext, SettingsContextValue, Config } from '../../context/SettingsContext';

// Mock SettingsContext value with full type compliance
const createMockSettings = (activeProfile = 'default'): SettingsContextValue => ({
    config: {
        app: {
            max_input_length: 4096,
            graph_recursion_limit: 10,
            tool_execution_timeout: 30,
            dangerous_patterns: [],
            language: 'ja'
        },
        llm_manager: {
            process_terminate_timeout: 5,
            health_check_timeout: 10,
            health_check_interval: 30,
            tokenizer_model_key: 'default'
        },
        chat_history: {
            max_tokens: 4096
        },
        em_llm: {
            surprise_gamma: 0.5,
            min_event_size: 10,
            max_event_size: 100,
            total_retrieved_events: 5,
            repr_topk: 3,
            use_boundary_refinement: true
        },
        models_gguf: {
            text_model: { path: 'model.gguf', port: 8000, n_ctx: 4096, n_gpu_layers: 0 },
            embedding_model: { path: 'embed.gguf', port: 8001, n_ctx: 512, n_gpu_layers: 0 }
        },
        characters: {
            default: {
                name: 'Tepora',
                description: 'Default assistant',
                system_prompt: 'You are Tepora.',
            },
            casual: {
                name: 'Barista',
                description: 'Casual assistant',
                system_prompt: 'You are a friendly barista.',
            }
        },
        professionals: {},
        active_agent_profile: activeProfile,
    } as Config,
    loading: false,
    error: null,
    hasChanges: false,
    saving: false,
    fetchConfig: vi.fn().mockResolvedValue(undefined),
    updateApp: vi.fn(),
    updateLlmManager: vi.fn(),
    updateChatHistory: vi.fn(),
    updateEmLlm: vi.fn(),
    updateModel: vi.fn(),
    updateCharacter: vi.fn(),
    addCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    setActiveAgent: vi.fn(),
    saveConfig: vi.fn().mockResolvedValue(true),
    resetConfig: vi.fn(),
});

const renderWithContext = (mockSettings = createMockSettings()) => {
    return render(
        <SettingsContext.Provider value={mockSettings}>
            <PersonaSwitcher />
        </SettingsContext.Provider>
    );
};

describe('PersonaSwitcher', () => {
    it('renders correctly', () => {
        renderWithContext();
        expect(screen.getByTitle('Switch Persona')).toBeInTheDocument();
    });

    it('opens menu on click', () => {
        renderWithContext();

        const button = screen.getByTitle('Switch Persona');
        fireEvent.click(button);

        // Check for dropdown content
        expect(screen.getByText('Tepora')).toBeInTheDocument();
        expect(screen.getByText('Barista')).toBeInTheDocument();
    });

    it('calls setActiveAgent when a persona is selected', async () => {
        const mockSettings = createMockSettings();
        renderWithContext(mockSettings);

        // Open menu
        fireEvent.click(screen.getByTitle('Switch Persona'));

        // Select Barista
        fireEvent.click(screen.getByText('Barista'));

        expect(mockSettings.setActiveAgent).toHaveBeenCalledWith('casual');
    });

    it('renders without crashing when active profile is different', () => {
        const mockSettings = createMockSettings('casual');
        renderWithContext(mockSettings);

        fireEvent.click(screen.getByTitle('Switch Persona'));

        // Both personas should be visible
        expect(screen.getByText('Tepora')).toBeInTheDocument();
        expect(screen.getByText('Barista')).toBeInTheDocument();
    });
});
