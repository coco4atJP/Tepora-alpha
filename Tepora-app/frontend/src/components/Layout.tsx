import {
	Bot,
	History,
	MessageSquare,
	Search,
	Settings as SettingsIcon,
} from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
import { useWebSocketContext } from "../context/WebSocketContext";
import type { Attachment, ChatMode } from "../types";
import AgentStatus from "./AgentStatus";
import DialControl from "./DialControl";
import RagContextPanel from "./RagContextPanel";
import { SessionHistoryModal } from "./SessionHistory/SessionHistoryModal";
import SystemStatusPanel from "./SystemStatusPanel";
import SettingsDialog from "./settings/SettingsDialog";
import DynamicBackground from "./ui/DynamicBackground";

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
	<button
		type="button"
		onClick={() => onClick(mode)}
		className={`flex flex-col items-center justify-center p-2 rounded-lg transition-all duration-300 ${
			isActive
				? "text-gold-400 bg-white/10"
				: "text-gray-400 hover:text-gray-200"
		} focus:outline-none focus:ring-2 focus:ring-gold-400/60 focus:ring-offset-2 focus:ring-offset-gray-950`}
	>
		<Icon
			size={20}
			className={isActive ? "drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]" : ""}
		/>
		<span className="text-[10px] mt-1 font-medium tracking-wide">{label}</span>
	</button>
);

const Layout: React.FC = () => {
	const [currentMode, setCurrentMode] = useState<ChatMode>("direct");
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [isHistoryOpen, setIsHistoryOpen] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { t } = useTranslation();

	// Use Context instead of local hook
	const wsData = useWebSocketContext();
	const { searchResults, isConnected, memoryStats, activityLog } = wsData;

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
		<div className="flex flex-col h-[100dvh] w-full overflow-hidden relative font-sans bg-gray-950">
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
			<DynamicBackground />
			<div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
				<div className="absolute inset-0 bg-gradient-to-b from-black/60 via-tea-950/40 to-black/70 mix-blend-multiply"></div>
				<div className="absolute inset-0 bg-gradient-to-tr from-tepora-start/20 via-transparent to-tepora-accent/5 animate-gradient-x opacity-60"></div>

				{/* Ambient Orbs */}
				<div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] bg-tea-500/5 rounded-full blur-[100px] animate-float"></div>
				<div className="absolute bottom-[-10%] right-[-10%] w-[40vw] h-[40vw] bg-purple-900/10 rounded-full blur-[100px] animate-pulse-slow"></div>
			</div>

			{/* Main Content Grid */}
			<div className="relative z-10 flex-1 w-full px-2 md:px-4 py-2 md:py-4">
				<div className="mx-auto h-full w-full max-w-7xl grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 lg:gap-6 min-h-0">
					{/* Left Column: Chat Interface */}
					<div className="h-full flex flex-col min-h-0 order-1 w-full">
						<div className="flex-1 glass-tepora rounded-3xl overflow-hidden relative shadow-2xl border border-white/10 ring-1 ring-white/5 min-h-0 flex flex-col">
							{/* Chat View - Visible on Desktop OR when mode is 'direct' on Mobile */}
							<div
								className={`absolute inset-0 z-0 flex flex-col ${currentMode !== "direct" ? "hidden lg:flex" : "flex"}`}
							>
								<Outlet
									context={{
										currentMode,
										attachments,
										onFileSelect: handleAddAttachment,
										onRemoveAttachment: handleRemoveAttachment,
										clearAttachments,
									}}
								/>
							</div>

							{/* Mobile Search View */}
							{currentMode === "search" && (
								<div className="absolute inset-0 z-10 flex flex-col lg:hidden bg-transparent overflow-hidden p-4">
									<RagContextPanel
										attachments={attachments}
										onAddAttachment={handleAddAttachment}
										onRemoveAttachment={handleRemoveAttachment}
										searchResults={searchResults}
									/>
								</div>
							)}

							{/* Mobile Agent View */}
							{currentMode === "agent" && (
								<div className="absolute inset-0 z-10 flex flex-col lg:hidden bg-transparent overflow-hidden p-4">
									<AgentStatus activityLog={activityLog} />
								</div>
							)}

							{/* Mobile Status Indicator (Visible only on small screens) */}
							{currentMode !== "direct" && (
								<div className="lg:hidden absolute top-2 right-2 z-20 pointer-events-none">
									<div
										className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]"}`}
									/>
								</div>
							)}
						</div>
					</div>

					{/* Right Column: Sidebar Controls & Dynamic Panels */}
					<div className="hidden lg:flex flex-col gap-6 pt-2 min-h-0 order-2">
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
						<div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden pr-2">
							{currentMode === "search" && (
								<RagContextPanel
									attachments={attachments}
									onAddAttachment={handleAddAttachment}
									onRemoveAttachment={handleRemoveAttachment}
									searchResults={searchResults}
								/>
							)}
							{currentMode === "agent" && (
								<AgentStatus activityLog={activityLog} />
							)}

							{/* System Status Panel (Visible in Chat mode) */}
							{currentMode === "direct" && (
								<>
									{/* Session History Button & System Status */}
									<div className="flex-1 min-h-0 flex flex-col justify-end">
										<div className="flex justify-end px-2 pb-2">
											<button
												type="button"
												onClick={() => setIsHistoryOpen(true)}
												className="p-3 text-gray-400 hover:text-white hover:bg-white/10 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-gold-400/60 focus:ring-offset-2 focus:ring-offset-gray-950"
												title={t("sessionHistory", "History")}
											>
												<History size={28} />
											</button>
										</div>
										<div className="shrink-0">
											<SystemStatusPanel
												isConnected={isConnected}
												memoryStats={memoryStats}
											/>
										</div>
									</div>
								</>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* Mobile Navigation Bar */}
			<div className="lg:hidden relative z-20 glass-panel border-t border-white/10 pb-safe">
				<div className="flex justify-around items-center p-3">
					<MobileNavButton
						mode="direct"
						icon={MessageSquare}
						label={t("dial.chat")}
						isActive={currentMode === "direct"}
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

					<button
						type="button"
						onClick={() => setIsSettingsOpen(true)}
						className="flex flex-col items-center justify-center p-2 rounded-lg transition-colors text-gray-400 hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-gold-400/60 focus:ring-offset-2 focus:ring-offset-gray-950"
					>
						<SettingsIcon size={20} />
						<span className="text-[10px] mt-1 font-medium tracking-wide">
							{t("common.settings")}
						</span>
					</button>
				</div>
			</div>

			{/* Settings Dialog */}
			<SettingsDialog
				isOpen={isSettingsOpen}
				onClose={() => setIsSettingsOpen(false)}
			/>

			{/* Session History Modal */}
			<SessionHistoryModal
				isOpen={isHistoryOpen}
				onClose={() => setIsHistoryOpen(false)}
			/>
		</div>
	);
};

export default Layout;
