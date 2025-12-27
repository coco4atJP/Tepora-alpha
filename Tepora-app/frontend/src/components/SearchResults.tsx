import React from 'react';
import { SearchResult } from '../types';
import { ExternalLink, Search, Globe, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SearchResultsProps {
    results: SearchResult[] | null;
}

const SearchResults: React.FC<SearchResultsProps> = ({ results }) => {
    const { t } = useTranslation();

    if (!results) return null;

    if (results.length === 0) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-gray-500 p-8 glass-panel animate-fade-in">
                <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
                    <Search className="w-6 h-6 opacity-50" />
                </div>
                <span className="text-sm font-medium">{t('search.no_results')}</span>
            </div>
        );
    }

    return (
        <div className="h-full max-h-[calc(100vh-320px)] flex flex-col glass-panel p-4 overflow-hidden animate-fade-in border border-tea-500/10">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3 text-tea-400 border-b border-white/10 pb-2 shrink-0">
                <Globe className="w-4 h-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.2em] font-display">
                    {t('search.title')}
                </h3>
                <span className="ml-auto text-[10px] bg-tea-500/10 px-2 py-0.5 rounded-full text-tea-300">
                    {results.length} {t('search.hits')}
                </span>
            </div>

            {/* Scrollable List */}
            <div className="overflow-y-auto custom-scrollbar flex-1 -mr-2 pr-2 space-y-3">
                {results.map((result, index) => (
                    <a
                        key={index}
                        href={result.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block group relative p-3 rounded-xl bg-black/20 hover:bg-white/5 border border-white/5 hover:border-tea-500/30 transition-all duration-300"
                    >
                        {/* Hover Glow */}
                        <div className="absolute inset-0 rounded-xl bg-tea-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                        <div className="relative z-10">
                            <h4 className="text-xs font-medium text-tea-200 group-hover:text-tea-100 flex items-center gap-2 leading-tight mb-1.5">
                                <span className="line-clamp-2">{result.title}</span>
                                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
                            </h4>

                            <p className="text-[10px] text-gray-500 line-clamp-2 leading-relaxed mb-2 group-hover:text-gray-400 transition-colors">
                                {result.snippet}
                            </p>

                            <div className="flex items-center gap-1.5 text-[9px] text-tea-500/50 font-mono">
                                <Globe className="w-2.5 h-2.5" />
                                <span className="truncate max-w-[150px]">{new URL(result.url).hostname}</span>
                            </div>
                        </div>

                        {/* Arrow indicator */}
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all duration-300 text-tea-400">
                            <ChevronRight className="w-4 h-4" />
                        </div>
                    </a>
                ))}
            </div>

            {/* Footer Fade */}
            <div className="h-4 shrink-0 bg-gradient-to-t from-black/20 to-transparent -mx-4 -mb-4 mt-2 pointer-events-none"></div>
        </div>
    );
};

export default SearchResults;
