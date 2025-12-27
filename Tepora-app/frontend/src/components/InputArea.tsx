import React, { useRef, useEffect, useState } from 'react';
import { Send, StopCircle, Mic, Loader2, Globe, Image as ImageIcon } from 'lucide-react';
import { ChatMode } from '../types';
import { useTranslation } from 'react-i18next';

interface InputAreaProps {
    input: string;
    setInput: (value: string) => void;
    handleSend: () => void;
    isLoading: boolean;
    isProcessing: boolean;
    stopGeneration: () => void;
    mode: ChatMode;
    isConnected: boolean;
}

const InputArea: React.FC<InputAreaProps> = ({
    input,
    setInput,
    handleSend,
    isLoading,
    isProcessing,
    stopGeneration,
    mode,
    isConnected
}) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { t } = useTranslation();
    const [skipWebSearch, setSkipWebSearch] = useState(false);

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    }, [input]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="relative w-full max-w-4xl mx-auto">
            {/* Search Toggle (Only in Search Mode) */}
            {mode === 'search' && (
                <button
                    onClick={() => setSkipWebSearch(!skipWebSearch)}
                    className={`absolute -top-10 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300 border backdrop-blur-md ${
                        !skipWebSearch
                        ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30 shadow-[0_0_10px_rgba(0,240,255,0.2)]'
                        : 'bg-black/40 text-gray-400 border-white/10 hover:bg-white/5'
                    }`}
                >
                    <Globe className={`w-3.5 h-3.5 ${!skipWebSearch ? 'animate-pulse' : ''}`} />
                    {!skipWebSearch ? t('input.web_search_on') : t('input.web_search_off')}
                </button>
            )}

            {/* Input Container */}
            <div className={`relative flex items-end gap-2 p-2 rounded-[2rem] glass-tea transition-all duration-500 ${
                isProcessing ? 'border-tea-500/30 shadow-[0_0_20px_rgba(233,122,58,0.1)]' : 'border-white/10'
            }`}>

                {/* Tools Button (Placeholder for future expansion) */}
                <button className="p-3 text-gray-400 hover:text-tea-300 transition-colors rounded-full hover:bg-white/5 hidden sm:flex">
                    <ImageIcon className="w-5 h-5" />
                </button>

                {/* Text Input */}
                <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                        mode === 'search' ? t('input.placeholder_search') :
                        mode === 'agent' ? t('input.placeholder_agent') :
                        t('input.placeholder_chat')
                    }
                    className="flex-1 bg-transparent text-tea-50 placeholder-gray-500 min-h-[44px] max-h-[200px] py-3 px-2 focus:outline-none resize-none custom-scrollbar font-sans text-[15px] leading-relaxed"
                    disabled={isProcessing && !isLoading}
                />

                {/* Voice Input (Placeholder) */}
                <button
                    className="p-3 text-gray-400 hover:text-tea-300 transition-colors rounded-full hover:bg-white/5"
                    title={t('input.voice_input')}
                >
                    <Mic className="w-5 h-5" />
                </button>

                {/* Send / Stop Button */}
                <div className="p-1">
                    {isLoading || isProcessing ? (
                        <button
                            onClick={stopGeneration}
                            className="w-10 h-10 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 flex items-center justify-center transition-all duration-300 border border-red-500/30 group"
                            title={t('input.stop')}
                        >
                            <StopCircle className="w-5 h-5 group-hover:scale-110 transition-transform" />
                        </button>
                    ) : (
                        <button
                            onClick={handleSend}
                            disabled={!input.trim() || !isConnected}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300 shadow-lg ${
                                input.trim() && isConnected
                                ? 'bg-gradient-to-br from-tea-500 to-tea-700 text-white hover:shadow-[0_0_15px_rgba(233,122,58,0.4)] hover:scale-105 active:scale-95'
                                : 'bg-gray-800/50 text-gray-600 cursor-not-allowed'
                            }`}
                        >
                            {isProcessing ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : (
                                <Send className={`w-5 h-5 ${input.trim() ? 'ml-0.5' : ''}`} />
                            )}
                        </button>
                    )}
                </div>
            </div>

            {/* Footer / Status Info */}
            <div className="flex justify-between items-center mt-2 px-4 text-[10px] text-gray-500 font-medium">
                <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.5)]' : 'bg-red-500'}`}></span>
                    {isConnected ? 'System Online' : 'System Offline'}
                </div>
                <div className="flex gap-4">
                     <span>{input.length} chars</span>
                     <span>Markdown Supported</span>
                </div>
            </div>
        </div>
    );
};

export default InputArea;
