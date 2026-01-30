import { Plus } from "lucide-react";
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
}

const ChatInterface: React.FC = () => {
	const { currentMode, attachments, skipWebSearch } =
		useOutletContext<ChatInterfaceContext>();
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

	const isConnected = useWebSocketStore((state) => state.isConnected);
	const sendMessage = useWebSocketStore((state) => state.sendMessage);
	const stopGeneration = useWebSocketStore((state) => state.stopGeneration);
	const pendingToolConfirmation = useWebSocketStore(
		(state) => state.pendingToolConfirmation,
	);
	const handleToolConfirmation = useWebSocketStore(
		(state) => state.handleToolConfirmation,
	);
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

	const handlePromptSelect = (prompt: string) => {
		if (isConnected) {
			sendMessage(
				prompt,
				currentMode,
				attachments,
				skipWebSearch || false,
				false,
			);
		}
	};

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

	return (
		<div className="flex flex-col h-full w-full relative">
			<ShortcutsDialog
				isOpen={showShortcuts}
				onClose={() => setShowShortcuts(false)}
			/>

			{/* Tool Confirmation Dialog */}
			<ToolConfirmationDialog
				request={pendingToolConfirmation}
				onAllow={(requestId, remember) =>
					handleToolConfirmation(requestId, true, remember)
				}
				onDeny={(requestId) => handleToolConfirmation(requestId, false, false)}
			/>

			{/* Header */}
			<div className="shrink-0 flex items-center gap-3 px-3 md:px-4 py-3 glass-base border-b-0 z-20">
				<Button
					variant="secondary"
					size="sm"
					onClick={handleCreateSession}
					className="text-tea-200 hover:text-gold-300 gap-2 border-white/5 hover:border-gold-500/30"
					title={t("newSession", "New Session")}
					aria-label={t("newSession", "New Session")}
				>
					<Plus className="w-4 h-4" />
					<span className="hidden sm:inline">
						{t("newSession", "New Session")}
					</span>
				</Button>

				<div className="ml-auto flex items-center gap-2">
					<span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] font-bold tracking-widest text-gold-100 font-display uppercase shadow-inner">
						{modeLabel}
					</span>
					<div className="flex items-center gap-2">
						<div
							className={`w-2 h-2 rounded-full ${
								isConnected
									? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"
									: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]"
							}`}
							aria-hidden="true"
						/>
						<span className="hidden md:inline text-xs text-gray-400">
							{isConnected
								? t("status.connected", "Connected")
								: t("status.disconnected", "Disconnected")}
						</span>
					</div>
				</div>
			</div>

			{/* Message List - Scrollable Area */}
			<div className="flex-1 overflow-hidden relative min-h-0">
				{messages.length === 0 ? (
					<EmptyState onPromptSelect={handlePromptSelect} />
				) : (
					<MessageList />
				)}
			</div>

			{/* Input Area - Fixed at Bottom */}
			<div className="p-2 md:p-4 w-full shrink-0">
				<InputArea />
			</div>
		</div>
	);
};

export default ChatInterface;
