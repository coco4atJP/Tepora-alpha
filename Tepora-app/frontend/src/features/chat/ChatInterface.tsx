import { History, Plus, Settings } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../context/ToastContext";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useSessions } from "../../hooks/useSessions";
import { useChatStore, useWebSocketStore } from "../../stores";
import type { Attachment, ChatMode } from "../../types";
import { EmptyState } from "./components/EmptyState";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import InputArea from "./InputArea";
import MessageList from "./MessageList";
import ToolConfirmationDialog from "./ToolConfirmationDialog";

export interface ChatInterfaceContext {
	currentMode: ChatMode;
	attachments: Attachment[];
	onFileSelect: () => void;
	onRemoveAttachment: (index: number) => void;
	clearAttachments: () => void;
	skipWebSearch?: boolean;
	onOpenHistory?: () => void;
	onOpenSettings?: () => void;
}

const ChatInterface: React.FC = () => {
	const { currentMode, onOpenHistory, onOpenSettings } = useOutletContext<ChatInterfaceContext>();
	const { t } = useTranslation();
	const { createSession } = useSessions();
	const { showToast } = useToast();

	// Store Hooks
	const messages = useChatStore((state) => state.messages);
	const error = useChatStore((state) => state.error);
	const clearError = useChatStore((state) => state.clearError);

	useEffect(() => {
		if (error) {
			showToast("error", error);
			clearError();
		}
	}, [error, showToast, clearError]);


	const stopGeneration = useWebSocketStore((state) => state.stopGeneration);
	const pendingToolConfirmation = useWebSocketStore((state) => state.pendingToolConfirmation);
	const handleToolConfirmation = useWebSocketStore((state) => state.handleToolConfirmation);
	const setSession = useWebSocketStore((state) => state.setSession);

	const [showShortcuts, setShowShortcuts] = useState(false);

	useKeyboardShortcuts([
		{
			key: "k",
			ctrlKey: true,
			action: (e) => {
				e.preventDefault();
				handleCreateSession();
			},
		},
		{
			key: "Escape",
			action: () => {
				if (useChatStore.getState().isProcessing) {
					stopGeneration();
					showToast("info", t("chat.generationStopped", "Generation stopped"));
				} else {
					setShowShortcuts(false);
				}
			},
		},
		{
			key: "?",
			action: () => setShowShortcuts((prev) => !prev),
			preventDefault: true,
		},
	]);

	const handleCreateSession = async () => {
		const session = await createSession();
		if (session) {
			setSession(session.id);
		}
	};

	const modeLabel =
		currentMode === "chat"
			? t("dial.chat")
			: currentMode === "search"
				? t("dial.search")
				: t("dial.agent");
	const shouldCenterInput = messages.length === 0;

	return (
		<div className="flex flex-col h-full w-full relative bg-bg-app/50 text-text-primary">
			<ShortcutsDialog isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />

			{/* Tool Confirmation Dialog */}
			<ToolConfirmationDialog
				request={pendingToolConfirmation}
				onAllow={(requestId, remember) => handleToolConfirmation(requestId, true, remember)}
				onDeny={(requestId) => handleToolConfirmation(requestId, false, false)}
			/>

			{/* Ambient Glows */}
			<div className="absolute top-[20%] right-[-10%] w-[60%] h-[60%] bg-[radial-gradient(circle,rgba(60,30,20,0.08)_0%,transparent_60%)] pointer-events-none" />

			{/* Header */}
			<div className="shrink-0 flex items-center gap-2 px-4 py-3 md:px-6 md:py-4 glass-base border-b border-border-highlight z-20 rounded-none shadow-sm backdrop-blur-md">
				<Button
					variant="secondary"
					size="sm"
					onClick={handleCreateSession}
					className="text-tea-100/90 hover:text-gold-300 gap-2 border-white/10 hover:border-gold-400/30 glass-button rounded-xl hover:shadow-[0_0_12px_rgba(252,211,77,0.15)]"
					title={t("newSession", "New Session")}
					aria-label={t("newSession", "New Session")}
				>
					<Plus className="w-4 h-4" />
					<span className="hidden sm:inline font-medium tracking-wide">{t("newSession", "New Session")}</span>
				</Button>

				<div className="ml-auto flex items-center gap-2 md:gap-3">
					{onOpenHistory && (
						<Button
							variant="ghost"
							size="icon"
							onClick={onOpenHistory}
							className="w-10 h-10 rounded-full text-tea-200/70 hover:text-gold-300 hover:bg-gold-500/10"
							aria-label={t("sessionHistory", "Session History")}
						>
							<History className="w-5 h-5" />
						</Button>
					)}
					{onOpenSettings && (
						<Button
							variant="ghost"
							size="icon"
							onClick={onOpenSettings}
							className="w-9 h-9 rounded-full text-tea-200/70 hover:text-gold-300 hover:bg-gold-500/10 lg:hidden"
							aria-label={t("common.settings")}
						>
							<Settings className="w-4 h-4" />
						</Button>
					)}
					<span className="px-3 py-1 rounded-lg glass-base text-[10px] font-bold tracking-widest text-gold-200 font-display uppercase shadow-inner border-white/5">
						{modeLabel}
					</span>
				</div>
			</div>

			{/* Message List - Scrollable Area */}
			<div className="flex-1 overflow-hidden relative min-h-0 w-full max-w-5xl mx-auto flex flex-col pt-4">
				{messages.length === 0 ? (
					<div
						className={`h-full flex flex-col justify-center items-center ${currentMode === "chat" ? "pb-[30vh]" : "pb-[30vh]"}`}
					>
						<EmptyState />
					</div>
				) : (
					<MessageList />
				)}
			</div>

			{/* Input Area - Dynamically Centered if Empty, Fixed at Bottom if Chatting */}
			<div
				className={`w-full z-20 max-w-[56rem] mx-auto transition-all duration-[800ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${shouldCenterInput
					? "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 mt-[10vh] px-4 w-11/12 lg:w-4/5 xl:w-[60rem] drop-shadow-2xl"
					: "relative shrink-0 p-3 md:p-6 pb-safe w-full drop-shadow-md"
					}`}
			>
				<InputArea />
			</div>
		</div>
	);
};

export default ChatInterface;
