import React, { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { SearchMode } from "../../../shared/contracts";
import { RadialMenu, type ChatModeType } from "./RadialMenu";
import type { ChatComposerAttachmentViewModel } from "./props";

export interface CommandAreaProps {
	draft: string;
	onDraftChange: (val: string) => void;
	onSend: () => void;
	onStop: () => void;
	onRegenerate: () => void;
	activeMode: ChatModeType;
	onModeChange: (mode: ChatModeType) => void;
	onSearchModeChange: (mode: SearchMode) => void;
	onOpenSettings?: () => void;
	onAddAttachment?: () => void;
	composer: {
		attachments: ChatComposerAttachmentViewModel[];
		thinkingBudget: number;
		searchMode: SearchMode;
		canSend: boolean;
		canStop: boolean;
		canRegenerate: boolean;
		isSending: boolean;
		canAttachImages: boolean;
	};
	onThinkingBudgetChange: (value: number) => void;
	onRemoveAttachment: (attachmentId: string) => void;
}

export const CommandArea: React.FC<CommandAreaProps> = ({
	draft,
	onDraftChange,
	onSend,
	onStop,
	onRegenerate,
	activeMode,
	onModeChange,
	onSearchModeChange,
	onOpenSettings,
	onAddAttachment,
	composer,
	onThinkingBudgetChange,
	onRemoveAttachment,
}) => {
	const { t } = useTranslation();
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
		}
	}, [draft]);

	return (
		<div className="flex flex-col rounded-[28px] border border-[color:var(--glass-border)] bg-[var(--glass-bg)] p-4 px-6 shadow-[var(--glass-shadow)] backdrop-blur-[30px] transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] focus-within:-translate-y-1 focus-within:border-primary/25 focus-within:shadow-[0_30px_60px_rgba(59,38,20,0.16)]">
			{composer.attachments.length > 0 ? (
				<div className="custom-scrollbar mb-3 flex gap-2 overflow-x-auto pl-[60px]">
					{composer.attachments.map((attachment) => {
						const isImage = attachment.type?.startsWith("image/") && attachment.content;
						return (
							<div
								key={attachment.id}
								className={`group relative flex items-center gap-2 rounded-lg border border-border bg-white/55 text-xs text-text-main ${
									isImage ? "h-12 w-12 shrink-0 overflow-hidden p-0" : "px-3 py-1.5"
								}`}
							>
								{isImage ? (
									<img
										src={`data:${attachment.type};base64,${attachment.content}`}
										alt={attachment.name}
										className="h-full w-full object-cover transition-opacity group-hover:opacity-60"
									/>
								) : (
									<span className="max-w-[180px] truncate">{attachment.name}</span>
								)}
								<button
									type="button"
									onClick={() => onRemoveAttachment(attachment.id)}
									className={`text-text-muted transition-colors hover:text-primary ${
										isImage
											? "absolute flex h-full w-full items-center justify-center bg-black/40 text-xl text-white opacity-0 group-hover:opacity-100"
											: ""
									}`}
									title={t("v2.chat.removeAttachment", "Remove attachment")}
								>
									×
								</button>
							</div>
						);
					})}
				</div>
			) : null}

			<div className="flex items-end gap-5">
				<RadialMenu
					currentMode={activeMode}
					onModeChange={onModeChange}
					onOpenSettings={onOpenSettings}
				/>

				<textarea
					ref={textareaRef}
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							if (composer.canSend) {
								onSend();
							}
						}
					}}
					placeholder={t("v2.chat.inputPlaceholder", "Type here...")}
					rows={1}
					style={{ minHeight: "32px", maxHeight: "400px" }}
					className="custom-scrollbar flex-1 resize-none overflow-y-auto border-none bg-transparent py-2 text-[1.05rem] font-medium text-text-main outline-none placeholder:font-light placeholder:text-text-muted/55"
				/>

				{composer.isSending || composer.canStop ? (
					<button
						type="button"
						onClick={onStop}
						className="flex h-11 w-11 items-center justify-center rounded-full border border-secondary/20 bg-secondary/10 text-secondary transition-all duration-300 hover:bg-secondary/20"
						title={t("v2.chat.stop", "Stop generation")}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
							<rect x="6" y="6" width="12" height="12" rx="2" ry="2" />
						</svg>
					</button>
				) : (
					<button
						type="button"
						onClick={onSend}
						disabled={!composer.canSend}
						className="flex h-11 w-11 items-center justify-center rounded-full border border-transparent bg-transparent text-text-muted/60 transition-all duration-300 hover:bg-primary/10 hover:text-primary disabled:opacity-40"
						title={t("v2.chat.send", "Send")}
					>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="22" y1="2" x2="11" y2="13" />
							<polygon points="22 2 15 22 11 13 2 9 22 2" />
						</svg>
					</button>
				)}
			</div>

			<div className="mt-3 flex items-center justify-between border-t border-dashed border-border pt-2.5 pl-[64px]">
				<div className="flex flex-wrap items-center gap-4">
					{activeMode === "search" ? (
						<div className="flex items-center gap-1 rounded-full border border-border bg-white/45 p-1 text-[0.68rem] uppercase tracking-[0.14em] text-text-muted">
							<button
								type="button"
								onClick={() => onSearchModeChange("quick")}
								className={`rounded-full px-2.5 py-1 transition-colors ${
									composer.searchMode === "quick"
										? "bg-primary/12 text-primary"
										: "hover:text-text-main"
								}`}
							>
								{t("v2.search.quick", "Quick")}
							</button>
							<button
								type="button"
								onClick={() => onSearchModeChange("deep")}
								className={`rounded-full px-2.5 py-1 transition-colors ${
									composer.searchMode === "deep"
										? "bg-primary/12 text-primary"
										: "hover:text-text-main"
								}`}
							>
								{t("v2.search.deep", "Deep")}
							</button>
						</div>
					) : null}

					<button
						type="button"
						onClick={() => onThinkingBudgetChange(composer.thinkingBudget > 0 ? 0 : 1)}
						className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
							composer.thinkingBudget > 0
								? "text-primary"
								: "text-text-muted hover:text-text-main"
						}`}
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="12" r="10" />
							<path d="M12 16v-4" />
							<path d="M12 8h.01" />
						</svg>
						{composer.thinkingBudget > 0
							? t("v2.chat.thinkingOn", "Deliberate mode on")
							: t("v2.chat.thinkingOff", "Deliberate mode off")}
					</button>

					<button
						type="button"
						onClick={onRegenerate}
						disabled={!composer.canRegenerate}
						className="flex items-center gap-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text-main disabled:opacity-40"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<path d="M3 2v6h6" />
							<path d="M21 12A9 9 0 0 0 6 5.3L3 8" />
							<path d="M21 22v-6h-6" />
							<path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" />
						</svg>
						{t("v2.chat.regenerate", "Regenerate")}
					</button>

					{composer.canAttachImages ? (
						<button
							type="button"
							onClick={onAddAttachment}
							className="flex items-center gap-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text-main"
						>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
							</svg>
							{t("v2.chat.attach", "Attach")}
						</button>
					) : null}

					{composer.isSending ? (
						<div className="flex items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-[0.68rem] uppercase tracking-[0.16em] text-primary/80">
							<span className="flex gap-1">
								<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/50" style={{ animationDelay: "0ms" }} />
								<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/50" style={{ animationDelay: "120ms" }} />
								<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/50" style={{ animationDelay: "240ms" }} />
							</span>
							{t("v2.chat.generating", "Generating")}
						</div>
					) : null}
					</div>

					<div className="text-[0.7rem] font-mono text-text-muted/50">
						{t("v2.chat.enterToSendHint", "Enter to send, Shift+Enter for newline")}
					</div>
				</div>
			</div>
		);
	};
