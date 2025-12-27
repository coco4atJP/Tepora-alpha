import React, { useRef, useEffect } from 'react';
import MessageList from './MessageList';
import InputArea from './InputArea';
import { useWebSocketContext } from '../context/WebSocketContext';
import { useChatState } from '../hooks/chat/useChatState';
import { ChatMode } from '../types';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Terminal, Trash2 } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';

const ChatInterface: React.FC = () => {
    const { currentMode } = useOutletContext<{ currentMode: ChatMode }>();
    const { messages, sendMessage, stopGeneration, clearMessages, isLoading, isProcessing } = useChatState();
    const { isConnected, error } = useWebSocketContext();
    const [input, setInput] = React.useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();

    // Auto-scroll to bottom
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isProcessing]);

    const handleSend = async () => {
        if (!input.trim()) return;
        const success = await sendMessage(input, currentMode);
        if (success) {
            setInput('');
        }
    };

    return (
        <div className="flex flex-col h-full relative">
            {/* Error Toast */}
            {error && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-500/90 text-white px-4 py-2 rounded-lg shadow-lg backdrop-blur-sm flex items-center gap-2 animate-fade-in text-sm border border-red-400/50">
                    <AlertCircle className="w-4 h-4" />
                    <span>{error}</span>
                </div>
            )}

            {/* Header / Toolbar */}
            <div className="flex-none p-4 border-b border-white/5 flex justify-between items-center bg-black/20 backdrop-blur-sm z-10">
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                        currentMode === 'search' ? 'bg-cyan-500/10 text-cyan-400' :
                        currentMode === 'agent' ? 'bg-purple-500/10 text-purple-400' :
                        'bg-tea-500/10 text-tea-400'
                    }`}>
                        <Terminal className="w-4 h-4" />
                    </div>
                    <div>
                        <h2 className="text-sm font-bold text-tea-100 uppercase tracking-widest font-display">
                            {t(`dial.${currentMode}`)}
                        </h2>
                        <div className="text-[10px] text-gray-500 font-mono">
                            {isConnected ? 'Connected to Neural Core' : 'Connection Lost'}
                        </div>
                    </div>
                </div>

                <button
                    onClick={clearMessages}
                    className="glass-button p-2 text-tea-200 hover:text-red-400 flex items-center gap-2 text-xs transition-colors"
                    title={t('common.clear_history')}
                >
                    <Trash2 className="w-4 h-4" />
                    <span className="hidden sm:inline">{t('common.clear')}</span>
                </button>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6 relative scroll-smooth">
                {messages.length === 0 ? (
                     <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 opacity-30 select-none pointer-events-none">
                        <Terminal className="w-16 h-16 mb-4" />
                        <p className="font-display text-lg tracking-widest">SYSTEM READY</p>
                        <p className="font-mono text-xs mt-2">Waiting for input...</p>
                     </div>
                ) : (
                    <MessageList messages={messages} />
                )}
                <div ref={messagesEndRef} className="h-4" />
            </div>

            {/* Input Area */}
            <div className="flex-none p-4 bg-gradient-to-t from-black/60 to-transparent">
                <InputArea
                    input={input}
                    setInput={setInput}
                    handleSend={handleSend}
                    isLoading={isLoading}
                    isProcessing={isProcessing}
                    stopGeneration={stopGeneration}
                    mode={currentMode}
                    isConnected={isConnected}
                />
            </div>
        </div>
    );
};

export default ChatInterface;
