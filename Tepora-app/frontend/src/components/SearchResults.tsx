import React from 'react';
import { Search, ExternalLink } from 'lucide-react';
import { SearchResult } from '../types';

interface SearchResultsProps {
    results: SearchResult[];
}

const SearchResults: React.FC<SearchResultsProps> = ({ results }) => {

    return (
        <div className="h-full max-h-[calc(100vh-320px)] flex flex-col glass-panel p-4 overflow-hidden animate-fade-in">
            <div className="flex items-center gap-2 mb-3 text-gold-400 border-b border-white/10 pb-2 shrink-0">
                <Search className="w-4 h-4" />
                <h3 className="text-sm font-bold uppercase tracking-wider font-display">Search Context</h3>
                <span className="ml-auto text-xs text-gray-500">{results.length} results</span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar min-h-0">
                {results.length === 0 ? (
                    <div className="text-center text-gray-500 text-sm py-8">
                        検索結果待機中...
                    </div>
                ) : (
                    results.map((result, index) => (
                        <div key={index} className="p-2.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors border border-white/5 group">
                            <a href={result.link} target="_blank" rel="noopener noreferrer" className="block">
                                <h4 className="text-xs font-medium text-gold-200 group-hover:text-gold-100 flex items-center gap-2 leading-tight">
                                    <span className="line-clamp-1">{result.title}</span>
                                    <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                                </h4>
                                <p className="text-[11px] text-gray-400 mt-1 line-clamp-2 leading-relaxed">{result.snippet}</p>
                                <div className="text-[9px] text-gray-500 mt-1.5 font-mono truncate opacity-60">{result.link}</div>
                            </a>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default SearchResults;
