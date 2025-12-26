import { render } from '@testing-library/react';
import { screen } from '@testing-library/dom';
import SearchResults from '../SearchResults';
import { describe, it, expect } from 'vitest';
import { SearchResult } from '../../types';

describe('SearchResults', () => {
    it('renders empty state', () => {
        render(<SearchResults results={[]} />);
        expect(screen.getByText('検索結果待機中...')).toBeInTheDocument();
        expect(screen.getByText('0 results')).toBeInTheDocument();
    });

    it('renders results correctly', () => {
        const mockResults: SearchResult[] = [
            {
                title: 'Test Result',
                link: 'https://example.com',
                snippet: 'This is a test snippet'
            }
        ];

        render(<SearchResults results={mockResults} />);

        expect(screen.getByText('Test Result')).toBeInTheDocument();
        expect(screen.getByText('This is a test snippet')).toBeInTheDocument();
        expect(screen.getByText('1 results')).toBeInTheDocument();

        const link = screen.getByRole('link');
        expect(link).toHaveAttribute('href', 'https://example.com');
        expect(link).toHaveAttribute('target', '_blank');
    });
});
