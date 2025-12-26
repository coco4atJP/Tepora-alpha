
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual('react-router-dom');
    return {
        ...actual,
        useOutletContext: () => ({ currentMode: 'chat' as ChatMode }),
    };
});

// Mock InputArea and MessageList to simplify integration test
// But for true integration, we should render them. However, if they are too complex
// or depend on other things, we might shallow render.
// Here we aim for "Integration" of components, so let's render them fully!
// Wait, scrolling behavior in MessageList might be tricky in jsdom.
// Let's mock scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();



// We need to mock the MODULE for WebSocketContext usage
vi.mock('../context/WebSocketContext', async () => {
    const actual = await vi.importActual('../context/WebSocketContext');
    return {
        ...actual,
        useWebSocketContext: vi.fn(),
    };
});

import { useWebSocketContext as mockUseWebSocketContext } from '../context/WebSocketContext';
import ChatInterface from '../components/ChatInterface';
import { ChatMode } from '../types';

describe('ChatInterface Integration', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders initial state correctly', () => {
        const mockSendMessage = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockUseWebSocketContext as any).mockReturnValue({
            isConnected: true,
            isProcessing: false,
            messages: [
                { id: '1', role: 'user', content: 'Hello', timestamp: new Date(1000) },
                { id: '2', role: 'assistant', content: 'Hi there', timestamp: new Date(1001) }
            ],
            sendMessage: mockSendMessage,
            error: null
        });

        render(<ChatInterface />);

        // Verify messages are displayed
        expect(screen.getByText('Hello')).toBeInTheDocument();
        expect(screen.getByText('Hi there')).toBeInTheDocument();

        // Verify input area is present (uses i18n key in test)
        expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('handles user input and sends message', async () => {
        const mockSendMessage = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockUseWebSocketContext as any).mockReturnValue({
            isConnected: true,
            isProcessing: false,
            messages: [],
            sendMessage: mockSendMessage,
            error: null
        });

        render(<ChatInterface />);

        const input = screen.getByRole('textbox');
        const sendButton = screen.getByRole('button', { name: /send/i });

        // Simulate typing
        fireEvent.change(input, { target: { value: 'Test Query' } });

        // Simulate send
        fireEvent.click(sendButton);

        // Verify sendMessage called with correct args
        // Assuming ChatMode 'chat' from outlet context mock
        expect(mockSendMessage).toHaveBeenCalledWith('Test Query', 'chat', [], false);
    });

    it('displays error toast when error occurs', () => {
        const mockClearError = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockUseWebSocketContext as any).mockReturnValue({
            isConnected: true,
            isProcessing: false,
            messages: [],
            sendMessage: vi.fn(),
            error: 'Connection Failed',
            clearError: mockClearError
        });

        render(<ChatInterface />);

        expect(screen.getByText('Connection Failed')).toBeInTheDocument();

        // Verify clear error interaction
        const closeBtn = screen.getByText('×');
        fireEvent.click(closeBtn);
        expect(mockClearError).toHaveBeenCalled();
    });

    it('disables input when processing', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockUseWebSocketContext as any).mockReturnValue({
            isConnected: true,
            isProcessing: true,
            messages: [],
            sendMessage: vi.fn(),
            error: null
        });

        render(<ChatInterface />);

        // Check for stop button or disabled input depending on InputArea implementation
        // If InputArea shows stop button when processing:
        expect(screen.getByLabelText(/stop generation/i)).toBeInTheDocument();

        // Input usually disabled or replaced
        const input = screen.queryByPlaceholderText(/Type a message.../i);
        // It might be disabled or still there, check attribute if implemented
        if (input) {
            expect(input).toBeDisabled();
        }
    });

    it('clears messages when header clear button clicked', () => {
        const mockClearMessages = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockUseWebSocketContext as any).mockReturnValue({
            isConnected: true,
            isProcessing: false,
            messages: [{ id: '1', role: 'user', content: 'History', timestamp: new Date(0) }],
            sendMessage: vi.fn(),
            clearMessages: mockClearMessages,
            error: null
        });

        render(<ChatInterface />);

        // Find clear button by its aria-label or as button containing Trash icon
        const clearBtn = screen.getByRole('button', { name: /clear/i });
        fireEvent.click(clearBtn);

        expect(mockClearMessages).toHaveBeenCalled();
    });
});
