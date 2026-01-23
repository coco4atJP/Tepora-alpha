import { Plus, X } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { useSessions } from "../../hooks/useSessions";
import { useChatStore, useWebSocketStore } from "../../stores";
import type { Attachment, ChatMode } from "../../types";
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
	const { currentMode } = useOutletContext<ChatInterfaceContext>();
	const { t } = useTranslation();
	const { createSession } = useSessions();

	// Store Hooks
	const error = useChatStore((state) => state.error);
	const clearError = useChatStore((state) => state.clearError);

	const isConnected = useWebSocketStore((state) => state.isConnected);
	const pendingToolConfirmation = useWebSocketStore(
		(state) => state.pendingToolConfirmation,
	);
	const handleToolConfirmation = useWebSocketStore(
		(state) => state.handleToolConfirmation,
	);
	const setSession = useWebSocketStore((state) => state.setSession);

	const handleCreateSession = async () => {
		const session = await createSession();
		if (session) {
			setSession(session.id);
		}
	};

	const modeLabel =
		currentMode === "direct"
			? t("dial.chat")
			: currentMode === "search"
				? t("dial.search")
				: t("dial.agent");

	return (
		<div className="flex flex-col h-full w-full relative">
			{/* Tool Confirmation Dialog */}
			<ToolConfirmationDialog
				request={pendingToolConfirmation}
				onAllow={(requestId, remember) =>
					handleToolConfirmation(requestId, true, remember)
				}
				onDeny={(requestId) => handleToolConfirmation(requestId, false, false)}
			/>

			{/* Error Toast */}
			{error && (
				<div
					className="absolute top-16 right-4 z-50 bg-red-500/90 text-white px-4 py-2 rounded shadow-lg backdrop-blur-sm flex items-center gap-2 animate-fade-in"
					role="alert"
					aria-live="assertive"
				>
					<span>{error}</span>
					<button
						type="button"
						onClick={clearError}
						className="hover:bg-white/20 rounded-full p-1 focus:outline-none focus:ring-2 focus:ring-white/60"
						aria-label={t("common.close", "Close")}
					>
						<X className="w-4 h-4" aria-hidden="true" />
					</button>
				</div>
			)}

			{/* Header */}
			<div className="shrink-0 flex items-center gap-3 px-3 md:px-4 py-2.5 border-b border-white/5 bg-black/10 backdrop-blur-md">
				<button
					type="button"
					onClick={handleCreateSession}
					className="glass-button px-3 py-2 text-coffee-200 hover:text-gold-300 flex items-center gap-2 text-xs"
					title={t("newSession", "New Session")}
					aria-label={t("newSession", "New Session")}
				>
					<Plus className="w-5 h-5" />
					<span className="hidden sm:inline">
						{t("newSession", "New Session")}
					</span>
				</button>

				<div className="ml-auto flex items-center gap-2">
					<span className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] font-semibold uppercase tracking-wider text-gray-200">
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
				<MessageList />
			</div>

			{/* Input Area - Fixed at Bottom */}
			<div className="p-2 md:p-4 w-full shrink-0">
				<InputArea />
			</div>
		</div>
	);
};

export default ChatInterface;
