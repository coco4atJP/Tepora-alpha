import { Brain, Send, Square } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { useSettings } from "../../hooks/useSettings";
import { useWebSocketStore } from "../../stores";
import type { ChatInterfaceContext } from "./ChatInterface";
import PersonaSwitcher from "./PersonaSwitcher";
import { useSelector } from "@xstate/react";
import { chatActor } from "../../machines/chatMachine";

const InputArea: React.FC = () => {
	const { currentMode, attachments, clearAttachments, skipWebSearch } =
		useOutletContext<ChatInterfaceContext>();

	const { t } = useTranslation();
	const [message, setMessage] = useState("");
	const [thinkingBudget, setThinkingBudget] = useState(0);
	const [selectedAgentId, setSelectedAgentId] = useState("");
	const [selectedAgentMode, setSelectedAgentMode] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Stores & State Machine
	const isConnected = useWebSocketStore((state) => state.isConnected);
	const sendMessage = useWebSocketStore((state) => state.sendMessage);
	const stopGeneration = useWebSocketStore((state) => state.stopGeneration);
	const { customAgents, config } = useSettings();

	const isIdle = useSelector(chatActor, (state) => state.matches("idle"));
	const isGenerating = useSelector(chatActor, (state) => state.matches("generating"));
	const isError = useSelector(chatActor, (state) => state.matches("error"));

	// We can only send when the machine is idle or in error (retry) state
	const canSend = (isIdle || isError) && isConnected && (message.trim().length > 0 || attachments.length > 0);
	const isProcessing = isGenerating;

	const availableAgents = Object.values(customAgents).filter(
		(agent) => agent.enabled,
	);

	const handleSend = () => {
		if (canSend) {
			sendMessage(
				message,
				currentMode,
				attachments,
				skipWebSearch,
				thinkingBudget,
				selectedAgentId || undefined,
				(selectedAgentMode as import("../../types").AgentMode) || undefined,
				config?.app.graph_execution_timeout,
			);
			chatActor.send({ type: "SEND_MESSAGE", payload: message });
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
			// Removed layout thrashing min max bounds if css handles it
			textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
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
				setThinkingBudget(config.thinking.chat_default ? 1 : 0);
			} else if (currentMode === "search") {
				setThinkingBudget(config.thinking.search_default ? 1 : 0);
			}
		}
	}, [currentMode, config?.thinking]);

	return (
		<div className="w-full max-w-7xl mx-auto relative group">
			<div className="absolute inset-0 bg-gold-500/5 blur-2xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
			<div
				className={`relative flex items-end gap-2 p-3 rounded-3xl glass-input transition-all duration-300 ${isProcessing
					? "ring-1 ring-gold-500/50 shadow-[0_0_20px_-5px_rgba(255,215,0,0.2)] bg-theme-overlay"
					: "hover:shadow-[0_10px_20px_rgba(0,0,0,0.2)] hover:bg-theme-overlay shadow-xl border border-white/10 group-focus-within:border-gold-400/50 group-focus-within:shadow-[0_0_20px_rgba(255,215,0,0.1)]"
					} backdrop-blur-xl`}
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
					className="flex-1 bg-transparent border-none outline-none text-theme-text placeholder-theme-subtext resize-none min-h-[44px] max-h-[200px] py-2.5 px-3 leading-relaxed font-sans text-[0.95rem] custom-scrollbar"
					rows={1}
					style={{ maxHeight: "200px" }}
				/>

				<div className="flex items-center gap-2 mb-1 mr-1">
					{/* Thinking Toggle */}
					<button
						type="button"
						onClick={() => setThinkingBudget((prev) => (prev + 1) % 4)}
						disabled={isProcessing}
						className={`w-8 h-8 rounded-full transition-all duration-300 flex items-center justify-center active:scale-90 relative ${thinkingBudget > 0
							? "bg-semantic-thinking/20 text-semantic-thinking ring-1 ring-semantic-thinking/50 shadow-[0_0_10px_-2px_rgba(168,85,247,0.3)]"
							: "text-gray-500 hover:text-semantic-thinking hover:bg-semantic-thinking/10"
							}`}
						title={`${t("chat.input.thinking_mode")} (Level ${thinkingBudget})`}
					>
						<Brain className="w-4 h-4" />
						{thinkingBudget > 0 && (
							<span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-semantic-thinking text-[8px] font-bold text-white shadow-sm ring-1 ring-black/50">
								{thinkingBudget}
							</span>
						)}
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
							disabled={!canSend}
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
			<div className="mt-3 hidden md:flex justify-end pr-4">
				<div className="text-[10px] text-gray-600 font-light tracking-widest opacity-60 font-display uppercase">
					{t("chat.input.mode_active", { mode: currentMode.toUpperCase() })}
				</div>
			</div>
		</div>
	);
};

export default InputArea;
