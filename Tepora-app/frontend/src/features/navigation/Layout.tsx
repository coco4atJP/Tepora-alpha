import { Bot, MessageSquare, Search, Settings as SettingsIcon, X } from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import DynamicBackground from "../../components/ui/DynamicBackground";
import { useTheme } from "../../context/ThemeContext";
import { useSettings } from "../../hooks/useSettings";
import { useChatStore, useWebSocketStore } from "../../stores";
import type { Attachment, ChatMode } from "../../types";
import AgentStatus from "../chat/AgentStatus";
import DialControl from "../chat/DialControl";
import RagContextPanel from "../chat/RagContextPanel";
import SystemStatusPanel from "../chat/SystemStatusPanel";
import { SessionHistoryModal } from "../session/components/SessionHistoryModal";
import SettingsDialog from "../settings/components/SettingsDialog";

// Extracted outside of Layout to prevent recreation on every render
interface MobileNavButtonProps {
	mode: ChatMode;
	icon: React.ElementType;
	label: string;
	isActive: boolean;
	onClick: (mode: ChatMode) => void;
}

const MobileNavButton: React.FC<MobileNavButtonProps> = ({
	mode,
	icon: Icon,
	label,
	isActive,
	onClick,
}) => (
	<Button
		variant={isActive ? "primary" : "ghost"}
		onClick={() => onClick(mode)}
		className={`flex flex-col items-center justify-center p-2 h-auto w-full rounded-lg transition-all duration-300 ${isActive ? "bg-white/10" : ""
			}`}
	>
		<Icon size={20} className={isActive ? "drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]" : ""} />
		<span
			className={`text-[10px] mt-1 font-medium tracking-wide ${isActive ? "text-gold-400" : ""}`}
		>
			{label}
		</span>
	</Button>
);

interface MobileOverlayPanelProps {
	title: string;
	closeLabel: string;
	onClose: () => void;
	children: React.ReactNode;
}

const MobileOverlayPanel: React.FC<MobileOverlayPanelProps> = ({
	title,
	closeLabel,
	onClose,
	children,
}) => (
	<div className="absolute inset-x-3 top-3 bottom-[5.5rem] z-20 lg:hidden">
		<div className="h-full rounded-2xl glass-panel border border-white/10 shadow-2xl overflow-hidden flex flex-col">
			<div className="shrink-0 px-3 py-2 border-b border-white/10 flex items-center justify-between">
				<span className="text-[10px] font-bold tracking-[0.2em] uppercase text-gold-200">
					{title}
				</span>
				<Button
					variant="ghost"
					size="icon"
					className="w-8 h-8 rounded-full"
					onClick={onClose}
					aria-label={closeLabel}
				>
					<X size={16} />
				</Button>
			</div>
			<div className="flex-1 min-h-0 p-3 pt-2">{children}</div>
		</div>
	</div>
);

const Layout: React.FC = () => {
	const [currentMode, setCurrentMode] = useState<ChatMode>("chat");
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [isHistoryOpen, setIsHistoryOpen] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [skipWebSearch, setSkipWebSearch] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { t } = useTranslation();
	const { activeTheme } = useTheme();
	const isTepora = activeTheme === "tepora";

	// Use Stores
	const { config } = useSettings();
	const isWebSearchAllowed = config?.privacy?.allow_web_search ?? false;
	const actualSkipWebSearch = !isWebSearchAllowed || skipWebSearch;

	const searchResults = useChatStore((state) => state.searchResults);
	const memoryStats = useChatStore((state) => state.memoryStats);
	const activityLog = useChatStore((state) => state.activityLog);
	const isConnected = useWebSocketStore((state) => state.isConnected);

	const handleModeChange = useCallback((mode: ChatMode) => {
		setCurrentMode(mode);
	}, []);

	// File handling functions
	const readFileAsBase64 = (file: File): Promise<string> => {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result === "string") {
					const commaIndex = reader.result.indexOf(",");
					if (commaIndex === -1) {
						reject(new Error("Invalid data URL"));
						return;
					}
					const base64Content = reader.result.slice(commaIndex + 1);
					resolve(base64Content);
				} else {
					reject(new Error("Failed to read file as string"));
				}
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	};

	const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files && e.target.files.length > 0) {
			const newAttachments: Attachment[] = [];

			for (let i = 0; i < e.target.files.length; i++) {
				const file = e.target.files[i];
				try {
					const content = await readFileAsBase64(file);
					newAttachments.push({
						name: file.name,
						content: content,
						type: file.type,
					});
				} catch (err) {
					console.error("Failed to read file:", file.name, err);
				}
			}

			setAttachments((prev) => [...prev, ...newAttachments]);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	const handleAddAttachment = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleRemoveAttachment = useCallback((index: number) => {
		setAttachments((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const clearAttachments = useCallback(() => {
		setAttachments([]);
	}, []);

	return (
		<div className="flex flex-col h-[100dvh] w-full overflow-hidden relative font-sans bg-theme-bg text-theme-text transition-colors duration-300">
			{/* Hidden File Input */}
			<input
				type="file"
				ref={fileInputRef}
				className="hidden"
				onChange={handleFileSelect}
				multiple
				accept=".txt,.md,.json,.xml,.csv,.log,.py,.js,.ts,.tsx,.jsx,.html,.css,.yml,.yaml,.toml,.ini,.cfg,.conf,.sh,.bat,.ps1,.c,.cpp,.h,.hpp,.java,.go,.rs,.rb,.php,.sql,.r,.m,.swift,.kt"
			/>
			{/* Dynamic Background with Tea Theme */}
			{isTepora && <DynamicBackground />}
			<div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
				{isTepora && (
					<>
						<div className="absolute inset-0 bg-gradient-to-b from-black/80 via-[#100a08]/70 to-black/90"></div>
						<div className="absolute inset-0 bg-gradient-to-tr from-gold-500/10 via-transparent to-tea-500/5 opacity-60"></div>
						{/* Ambient Deep Orbs (Static for performance) */}
						<div className="absolute top-[-20%] left-[-10%] w-[80vw] h-[80vw] bg-[radial-gradient(circle,rgba(120,60,20,0.1)_0%,transparent_50%)] pointer-events-none"></div>
						<div className="absolute bottom-[-20%] right-[-10%] w-[70vw] h-[70vw] bg-[radial-gradient(circle,rgba(60,30,20,0.1)_0%,transparent_50%)] pointer-events-none"></div>
					</>
				)}
			</div>

			{/* Main Content Grid */}
			<div className="relative z-10 flex-1 w-full px-2 md:px-4 py-2 md:py-4 mt-2">
				<div className="mx-auto h-full w-full max-w-[1440px] grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-3 lg:gap-5 min-h-0">
					{/* Left Column: Chat Interface */}
					<div className="h-full flex flex-col min-h-0 order-1 w-full overflow-hidden">
						<div className="flex-1 glass-tepora rounded-2xl md:rounded-3xl overflow-hidden relative shadow-2xl border border-white/10 ring-1 ring-white/5 min-h-0 flex flex-col">
							{/* Chat View - Always Visible to keep input reachable on mobile */}
							<div className="absolute inset-0 z-0 flex flex-col">
								<Outlet
									context={{
										currentMode,
										attachments,
										onFileSelect: handleAddAttachment,
										onRemoveAttachment: handleRemoveAttachment,
										clearAttachments,
										skipWebSearch: actualSkipWebSearch,
										onOpenHistory: () => setIsHistoryOpen(true),
										onOpenSettings: () => setIsSettingsOpen(true),
									}}
								/>
							</div>

							{/* Mobile Search View */}
							{currentMode === "search" && (
								<MobileOverlayPanel
									title={t("dial.search")}
									closeLabel={t("common.close")}
									onClose={() => setCurrentMode("chat")}
								>
									<RagContextPanel
										attachments={attachments}
										onAddAttachment={handleAddAttachment}
										onRemoveAttachment={handleRemoveAttachment}
										searchResults={searchResults}
										skipWebSearch={actualSkipWebSearch}
										onToggleWebSearch={() => setSkipWebSearch(!skipWebSearch)}
										webSearchAllowed={isWebSearchAllowed}
									/>
								</MobileOverlayPanel>
							)}

							{/* Mobile Agent View */}
							{currentMode === "agent" && (
								<MobileOverlayPanel
									title={t("dial.agent")}
									closeLabel={t("common.close")}
									onClose={() => setCurrentMode("chat")}
								>
									<AgentStatus activityLog={activityLog} />
								</MobileOverlayPanel>
							)}
						</div>
					</div>

					{/* Right Column: Sidebar Controls & Dynamic Panels */}
					<div className="hidden lg:grid grid-rows-[auto_minmax(0,1fr)_auto] gap-4 min-h-0 order-2">
						<div className="glass-panel rounded-3xl p-4 border border-white/10 shadow-xl shrink-0">
							<div className="relative flex justify-center">
								<div className="absolute inset-0 bg-gold-500/20 blur-3xl rounded-full"></div>
								<DialControl
									currentMode={currentMode}
									onModeChange={setCurrentMode}
									onSettingsClick={() => setIsSettingsOpen(true)}
								/>
							</div>
						</div>

						<div className="min-h-0 overflow-hidden flex flex-col">
							{currentMode === "search" && (
								<RagContextPanel
									attachments={attachments}
									onAddAttachment={handleAddAttachment}
									onRemoveAttachment={handleRemoveAttachment}
									searchResults={searchResults}
									skipWebSearch={actualSkipWebSearch}
									onToggleWebSearch={() => setSkipWebSearch(!skipWebSearch)}
									webSearchAllowed={isWebSearchAllowed}
								/>
							)}
							{currentMode === "agent" && <AgentStatus activityLog={activityLog} />}
							{currentMode === "chat" && (
								<div className="h-full glass-panel rounded-3xl p-6 border border-white/10 flex flex-col justify-center text-center">
									<p className="text-[10px] font-bold uppercase tracking-[0.24em] text-gold-300/80">
										{t("dial.chat")}
									</p>
									<p className="mt-3 text-sm text-theme-subtext leading-relaxed">
										{t("chat.input.system_ready_hint", "Select a mode and start chatting.")}
									</p>
								</div>
							)}
						</div>

						<SystemStatusPanel
							isConnected={isConnected}
							memoryStats={memoryStats}
						/>
					</div>
				</div>
			</div>

			{/* Mobile Navigation Bar */}
			<div className="lg:hidden relative z-20 glass-panel border-t border-white/10 pb-safe">
				<div className="flex justify-around items-center p-3">
					<MobileNavButton
						mode="chat"
						icon={MessageSquare}
						label={t("dial.chat")}
						isActive={currentMode === "chat"}
						onClick={handleModeChange}
					/>
					<MobileNavButton
						mode="search"
						icon={Search}
						label={t("dial.search")}
						isActive={currentMode === "search"}
						onClick={handleModeChange}
					/>
					<MobileNavButton
						mode="agent"
						icon={Bot}
						label={t("dial.agent")}
						isActive={currentMode === "agent"}
						onClick={handleModeChange}
					/>

					<Button
						variant="ghost"
						onClick={() => setIsSettingsOpen(true)}
						className="flex flex-col items-center justify-center p-2 h-auto w-full rounded-lg text-gray-400 hover:text-gray-200"
					>
						<SettingsIcon size={20} />
						<span className="text-[10px] mt-1 font-medium tracking-wide">
							{t("common.settings")}
						</span>
					</Button>
				</div>
			</div>

			{/* Settings Dialog */}
			<SettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

			{/* Session History Modal */}
			<SessionHistoryModal isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} />
		</div>
	);
};

export default Layout;
