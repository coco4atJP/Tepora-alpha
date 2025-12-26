import React, { useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import DialControl from './DialControl';
import SystemStatusPanel from './SystemStatusPanel';
import { ChatMode } from '../types';
import SettingsDialog from './settings/SettingsDialog';
import SearchResults from './SearchResults';
import AgentStatus from './AgentStatus';
import { useWebSocketContext } from '../context/WebSocketContext';
import { MessageSquare, Search, Bot, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const BACKGROUND_IMAGE_URL = '/assets/images/background.jpg';
// Fallback gradient when image is not available
const FALLBACK_GRADIENT = 'from-coffee-900 via-gray-900 to-coffee-950';

// Extracted outside of Layout to prevent recreation on every render
interface MobileNavButtonProps {
    mode: ChatMode;
    icon: React.ElementType;
    label: string;
    isActive: boolean;
    onClick: (mode: ChatMode) => void;
}

const MobileNavButton: React.FC<MobileNavButtonProps> = ({ mode, icon: Icon, label, isActive, onClick }) => (
    <button
        onClick={() => onClick(mode)}
        className={`flex flex-col items-center justify-center p-2 rounded-lg transition-all duration-300 ${isActive
            ? 'text-gold-400 bg-white/10'
            : 'text-gray-400 hover:text-gray-200'
            }`}
    >
        <Icon size={20} className={isActive ? 'drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]' : ''} />
        <span className="text-[10px] mt-1 font-medium tracking-wide">{label}</span>
    </button>
);

const Layout: React.FC = () => {
    const [currentMode, setCurrentMode] = useState<ChatMode>('direct');
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [bgImageLoaded, setBgImageLoaded] = useState(true);
    const { t } = useTranslation();

    // Use Context instead of local hook
    const wsData = useWebSocketContext();
    const { searchResults, isConnected, memoryStats, activityLog } = wsData;

    // Preload background image and handle errors
    React.useEffect(() => {
        const img = new Image();
        img.onload = () => setBgImageLoaded(true);
        img.onerror = () => setBgImageLoaded(false);
        img.src = BACKGROUND_IMAGE_URL;
    }, []);

    const handleModeChange = useCallback((mode: ChatMode) => {
        setCurrentMode(mode);
    }, []);

    return (
        <div className="flex flex-col h-[100dvh] w-full overflow-hidden relative font-sans bg-gray-950">
            {/* Background with Gemini Gradient Animation */}
            <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
                {bgImageLoaded ? (
                    <div className={`absolute inset-0 bg-[url('${BACKGROUND_IMAGE_URL}')] bg-cover bg-center opacity-30 blur-md transform scale-105`}></div>
                ) : (
                    <div className={`absolute inset-0 bg-gradient-to-br ${FALLBACK_GRADIENT} opacity-50`}></div>
                )}
                <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-coffee-950/80 to-black/90 mix-blend-multiply"></div>
                <div className="absolute inset-0 bg-gradient-to-tr from-gemini-start/20 via-transparent to-gemini-accent/5 animate-gradient-x opacity-60"></div>

                {/* Ambient Orbs */}
                <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] bg-gold-500/5 rounded-full blur-[100px] animate-float"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[40vw] h-[40vw] bg-purple-900/10 rounded-full blur-[100px] animate-pulse-slow"></div>
            </div>

            {/* Main Content Grid */}
            <div className="relative z-10 flex-1 w-full max-w-7xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 min-h-0">

                {/* Left Column: Chat Interface */}
                <div className="h-full flex flex-col min-h-0 order-1">
                    <div className="flex-1 glass-gemini rounded-3xl overflow-hidden relative shadow-2xl border border-white/10 ring-1 ring-white/5 min-h-0 flex flex-col">
                        {/* Chat View - Visible on Desktop OR when mode is 'direct' on Mobile */}
                        <div className={`absolute inset-0 z-0 flex flex-col ${currentMode !== 'direct' ? 'hidden lg:flex' : 'flex'}`}>
                            <Outlet context={{ currentMode }} />
                        </div>

                        {/* Mobile Search View */}
                        {currentMode === 'search' && (
                            <div className="absolute inset-0 z-10 flex flex-col lg:hidden bg-transparent overflow-y-auto custom-scrollbar p-4">
                                <SearchResults results={searchResults} />
                            </div>
                        )}

                        {/* Mobile Agent View */}
                        {currentMode === 'agent' && (
                            <div className="absolute inset-0 z-10 flex flex-col lg:hidden bg-transparent overflow-y-auto custom-scrollbar p-4">
                                <AgentStatus activityLog={activityLog} />
                            </div>
                        )}

                        {/* Mobile Status Indicator (Visible only on small screens) */}
                        <div className="lg:hidden absolute top-2 right-2 z-20 pointer-events-none">
                            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]'}`}></div>
                        </div>
                    </div>
                </div>

                {/* Right Column: Sidebar Controls & Dynamic Panels */}
                <div className="hidden lg:flex flex-col gap-6 pt-12 min-h-0 order-2">
                    {/* Dial Control - Always Visible */}
                    <div className="relative flex justify-center shrink-0">
                        <div className="absolute inset-0 bg-gold-500/20 blur-3xl rounded-full"></div>
                        <DialControl
                            currentMode={currentMode}
                            onModeChange={setCurrentMode}
                            onSettingsClick={() => setIsSettingsOpen(true)}
                        />
                    </div>

                    {/* Dynamic Info Panel */}
                    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto custom-scrollbar pr-2">
                        {currentMode === 'search' && <SearchResults results={searchResults} />}
                        {currentMode === 'agent' && <AgentStatus activityLog={activityLog} />}

                        {/* System Status Panel (Visible in Chat mode) */}
                        {currentMode === 'direct' && (
                            <SystemStatusPanel
                                isConnected={isConnected}
                                memoryStats={memoryStats}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* Mobile Navigation Bar */}
            <div className="lg:hidden relative z-20 glass-panel border-t border-white/10 pb-safe">
                <div className="flex justify-around items-center p-3">
                    <MobileNavButton mode="direct" icon={MessageSquare} label={t('dial.chat')} isActive={currentMode === 'direct'} onClick={handleModeChange} />
                    <MobileNavButton mode="search" icon={Search} label={t('dial.search')} isActive={currentMode === 'search'} onClick={handleModeChange} />
                    <MobileNavButton mode="agent" icon={Bot} label={t('dial.agent')} isActive={currentMode === 'agent'} onClick={handleModeChange} />

                    <button
                        onClick={() => setIsSettingsOpen(true)}
                        className="flex flex-col items-center justify-center p-2 rounded-lg transition-colors text-gray-400 hover:text-gray-200"
                    >
                        <SettingsIcon size={20} />
                        <span className="text-[10px] mt-1 font-medium tracking-wide">{t('common.settings')}</span>
                    </button>
                </div>
            </div>

            {/* Settings Dialog */}
            <SettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </div>
    );
};

export default Layout;
