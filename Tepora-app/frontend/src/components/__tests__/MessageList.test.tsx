import { render } from '@testing-library/react';
import { screen } from '@testing-library/dom';
import MessageList from '../MessageList';
import { describe, it, expect, vi } from 'vitest';
import { Message } from '../../types';

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('MessageList', () => {
    const mockMessages: Message[] = [
        {
            id: '1',
            role: 'user',
            content: 'Hello',
            timestamp: new Date('2023-01-01T10:00:00'),
        },
        {
            id: '2',
            role: 'assistant',
            content: 'Hi there! Here is some code:\n```python\nprint("hello")\n```',
            timestamp: new Date('2023-01-01T10:00:01'),
            mode: 'direct',
            isComplete: true,
        },
    ];

    it('renders messages correctly', () => {
        render(<MessageList messages={mockMessages} />);

        expect(screen.getByText('Hello')).toBeInTheDocument();
        expect(screen.getByText(/Hi there!/)).toBeInTheDocument();
    });

    it('renders code blocks', () => {
        const { container } = render(<MessageList messages={mockMessages} />);

        // Check if code block is rendered (SyntaxHighlighter usually renders pre/code)
        expect(screen.getByLabelText('python code block')).toBeInTheDocument();
        // Check text content of the code block container since syntax highlighter splits text
        expect(container.textContent).toContain('print("hello")');
    });

    it('renders empty state', () => {
        render(<MessageList messages={[]} />);
        expect(screen.getByText('System Ready')).toBeInTheDocument();
    });

    it('scrolls to bottom on new message', () => {
        const { rerender } = render(<MessageList messages={[]} />);
        // It might be called on initial render
        vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear();

        rerender(<MessageList messages={mockMessages} />);
        expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    });
});
