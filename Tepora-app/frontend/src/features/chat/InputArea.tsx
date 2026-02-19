import { Brain, Send, Square } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { useSettings } from "../../hooks/useSettings";
import { useChatStore, useWebSocketStore } from "../../stores";
import type { ChatInterfaceContext } from "./ChatInterface";
import PersonaSwitcher from "./PersonaSwitcher";

const InputArea: React.FC = () => {
	const { currentMode, attachments, clearAttachments, skipWebSearch } =
		useOutletContext<ChatInterfaceContext>();

	const { t } = useTranslation();
	const [message, setMessage] = useState("");
	const [isThinkingMode, setIsThinkingMode] = useState(false);
	const [selectedAgentId, setSelectedAgentId] = useState("");
	const [selectedAgentMode, setSelectedAgentMode] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Stores
	const isProcessing = useChatStore((state) => state.isProcessing);
	const isConnected = useWebSocketStore((state) => state.isConnected);
	const sendMessage = useWebSocketStore((state) => state.sendMessage);
	const stopGeneration = useWebSocketStore((state) => state.stopGeneration);
	const { customAgents, config } = useSettings();

	const availableAgents = Object.values(customAgents).filter(
		(agent) => agent.enabled,
	);

	const handleSend = () => {
		if ((message.trim() || attachments.length > 0) && !isProcessing && isConnected) {
			sendMessage(
				message,
				currentMode,
				attachments,
				skipWebSearch,
				isThinkingMode,
				selectedAgentId || undefined,
				(selectedAgentMode as import("../../types").AgentMode) || undefined,
				config?.app.graph_execution_timeout,
			);
			clearAttachments();
			setMessage("");
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto";
			}
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const getPlaceholder = () => {
		if (!isConnected) return t("chat.input.placeholder.connecting");
		switch (currentMode) {
			case "search":
				return t("chat.input.placeholder.search");
			case "agent":
				return t("chat.input.placeholder.agent");
			default:
				return t("chat.input.placeholder.default");
		}
	};

	// Auto-resize textarea
	// biome-ignore lint/correctness/useExhaustiveDependencies: resize on message change only
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
		}
	}, [message]);

	useEffect(() => {
		if (currentMode !== "agent") {
			setSelectedAgentId("");
			setSelectedAgentMode("");
		}

		// Apply default thinking mode from settings
		if (config?.thinking) {
			if (currentMode === "chat") {
				setIsThinkingMode(config.thinking.chat_default ?? false);
			} else if (currentMode === "search") {
				setIsThinkingMode(config.thinking.search_default ?? false);
			}
		}
	}, [currentMode, config?.thinking]);

	return (
		<div className="w-full max-w-7xl mx-auto relative group">
			<div
				className={`relative flex items-end gap-2 p-2 rounded-[2rem] glass-input transition-all duration-500 ${isProcessing
					? "ring-1 ring-gold-500/30 shadow-[0_0_30px_-5px_rgba(234,179,8,0.15)] bg-theme-overlay"
					: "hover:shadow-[0_4px_20px_rgba(0,0,0,0.2)] hover:bg-theme-overlay shadow-2xl"
					}`}
			>
				{/* Persona Switcher */}
				<div className="shrink-0 mb-1 ml-1">
					<PersonaSwitcher />
				</div>

				{/* Agent Controls (Agent Mode Only) */}
				{currentMode === "agent" && (
					<>
						<div className="shrink-0 mb-1">
							<select
								value={selectedAgentMode}
								onChange={(e) => setSelectedAgentMode(e.target.value)}
								disabled={isProcessing}
								className="h-9 px-3 rounded-full bg-black/30 border border-white/10 text-xs text-gray-200 font-mono focus:outline-none focus:border-tea-500"
								title={t("chat.input.agent_mode", "Agent mode")}
							>
								<option value="">{t("chat.input.agent_mode_fast", "Fast (Auto)")}</option>
								<option value="high">{t("chat.input.agent_mode_high", "High (Planning)")}</option>
								<option value="direct">{t("chat.input.agent_mode_direct", "Direct")}</option>
							</select>
						</div>
						{availableAgents.length > 0 && (
							<div className="shrink-0 mb-1">
								<select
									value={selectedAgentId}
									onChange={(e) => setSelectedAgentId(e.target.value)}
									disabled={isProcessing}
									className="h-9 px-3 rounded-full bg-black/30 border border-white/10 text-xs text-gray-200 font-mono focus:outline-none focus:border-tea-500"
									title={t("chat.input.select_agent", "Select agent")}
								>
									<option value="">{t("chat.input.agent_auto", "Auto (Supervisor)")}</option>
									{availableAgents.map((agent) => (
										<option key={agent.id} value={agent.id}>
											{agent.icon || "🤖"} {agent.name}
										</option>
									))}
								</select>
							</div>
						)}
					</>
				)}

				{/* Text Input */}
				<textarea
					ref={textareaRef}
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={getPlaceholder()}
					disabled={isProcessing || !isConnected}
					aria-label={t("chat.input.aria_label")}
					className="flex-1 bg-transparent border-none outline-none text-theme-text placeholder-theme-subtext resize-none min-h-[44px] max-h-[200px] py-3 px-2 leading-relaxed font-sans text-[0.95rem] scrollbar-thin scrollbar-thumb-theme-border scrollbar-track-transparent"
					rows={1}
					style={{ maxHeight: "200px" }}
				/>

				<div className="flex items-center gap-2 mb-1 mr-1">
					{/* Thinking Toggle */}
					<button
						type="button"
						onClick={() => setIsThinkingMode(!isThinkingMode)}
						disabled={isProcessing}
						className={`w-8 h-8 rounded-full transition-all duration-300 flex items-center justify-center active:scale-90 ${isThinkingMode
							? "bg-semantic-thinking/20 text-semantic-thinking ring-1 ring-semantic-thinking/50 shadow-[0_0_10px_-2px_rgba(168,85,247,0.3)]"
							: "text-gray-500 hover:text-semantic-thinking hover:bg-semantic-thinking/10"
							}`}
						title={t("chat.input.thinking_mode")}
					>
						<Brain className="w-4 h-4" />
					</button>

					{/* Send / Stop Button */}
					{isProcessing ? (
						<Button
							variant="danger"
							size="icon"
							onClick={() => stopGeneration()}
							aria-label={t("chat.input.stop_generation")}
							className="rounded-full w-10 h-10 shadow-lg"
						>
							<Square className="w-4 h-4 fill-current" aria-hidden="true" />
						</Button>
					) : (
						<Button
							variant={message.trim() || attachments.length > 0 ? "primary" : "ghost"}
							size="icon"
							onClick={handleSend}
							disabled={(!message.trim() && attachments.length === 0) || !isConnected}
							aria-label={t("chat.input.send_message")}
							className={`rounded-full w-10 h-10 transition-all duration-300 ${message.trim() || attachments.length > 0
								? "shadow-[0_0_20px_rgba(234,179,8,0.4)]"
								: "opacity-50"
								}`}
						>
							<Send
								className={`w-4 h-4 ${message.trim() || attachments.length > 0 ? "ml-0.5" : ""}`}
								aria-hidden="true"
							/>
						</Button>
					)}
				</div>
			</div>

			{/* Helper Text */}
			<div className="mt-2 hidden md:flex justify-end">
				<div className="text-[10px] text-gray-600 font-light tracking-widest opacity-60 font-display uppercase">
					{t("chat.input.mode_active", { mode: currentMode.toUpperCase() })}
				</div>
			</div>
		</div>
	);
};

export default InputArea;
