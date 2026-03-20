import React from "react";
import { useTranslation } from "react-i18next";
import type { ChatScreenViewProps } from "./props";
import { ChatMessageList } from "./ChatMessageList";
import { CommandArea } from "./CommandArea";
import { QuickPersonaSwitcher } from "./QuickPersonaSwitcher";

export const ChatScreenView: React.FC<
	ChatScreenViewProps & {
		onOpenSettings?: () => void;
		onAddAttachment?: () => void;
		onOpenLeftSidebar?: () => void;
		onOpenRightSidebar?: () => void;
	}
> = ({
	messages,
	draft,
	onDraftChange,
	activeMode,
	onModeChange,
	composer,
	onSend,
	onStop,
	onRegenerate,
	onThinkingBudgetChange,
	onAddAttachment,
	onRemoveAttachment,
	onOpenSettings,
	onOpenLeftSidebar,
	onOpenRightSidebar,
	shellState,
	connectionState,
	statusMessage,
}) => {
	const { t } = useTranslation();
	const showStatus =
		shellState === "loading" ||
		connectionState === "reconnecting" ||
		composer.isSending ||
		Boolean(statusMessage);

	let statusLabel = statusMessage;
	if (!statusLabel && shellState === "loading") {
		statusLabel = t("v2.common.loading", "Loading...");
	} else if (!statusLabel && connectionState === "reconnecting") {
		statusLabel = t("v2.chat.reconnecting", "Reconnecting...");
	} else if (!statusLabel && composer.isSending) {
		statusLabel = t("v2.chat.generating", "Generating");
	}

	return (
		<div className="relative flex h-full w-full flex-col">
			<div className="pointer-events-none absolute left-0 top-0 z-[45] flex w-full items-start justify-between p-4 md:p-6">
				<button
					type="button"
					onClick={onOpenLeftSidebar}
					className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--glass-border)] bg-[var(--glass-bg)] text-text-muted shadow-[var(--glass-shadow)] backdrop-blur-md transition-all hover:bg-surface/80 hover:text-primary"
					title={t("v2.session.openHistory", "Open history")}
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<line x1="3" y1="12" x2="21" y2="12" />
						<line x1="3" y1="6" x2="21" y2="6" />
						<line x1="3" y1="18" x2="21" y2="18" />
					</svg>
				</button>

				<div className="pointer-events-auto flex items-center gap-3">
					<QuickPersonaSwitcher />
					<button
						type="button"
						onClick={onOpenRightSidebar}
						className="flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--glass-border)] bg-[var(--glass-bg)] text-text-muted shadow-[var(--glass-shadow)] backdrop-blur-md transition-all hover:bg-surface/80 hover:text-primary"
						title={t("v2.agent.openPanel", "Open mode panel")}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="5" r="2.5" />
							<circle cx="6" cy="18" r="2.5" />
							<circle cx="18" cy="18" r="2.5" />
							<path d="M12 7.5v4" />
							<path d="M10.5 13.5 7.5 16" />
							<path d="M13.5 13.5 16.5 16" />
						</svg>
					</button>
				</div>
			</div>

			{showStatus ? (
				<div className="pointer-events-none absolute left-1/2 top-[76px] z-[40] -translate-x-1/2 px-4">
					<div className="flex items-center gap-2 rounded-full border border-primary/15 bg-[var(--glass-bg)] px-4 py-2 text-[0.72rem] uppercase tracking-[0.18em] text-text-muted shadow-[var(--glass-shadow)] backdrop-blur-md">
						<span className="flex gap-1">
							<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/50" style={{ animationDelay: "0ms" }} />
							<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/50" style={{ animationDelay: "120ms" }} />
							<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/50" style={{ animationDelay: "240ms" }} />
						</span>
						{statusLabel}
					</div>
				</div>
			) : null}

			<ChatMessageList messages={messages} isEmpty={messages.length === 0} />

			<div className="absolute bottom-10 left-1/2 z-50 w-full max-w-[800px] -translate-x-1/2 px-5">
				<CommandArea
					draft={draft}
					onDraftChange={onDraftChange}
					onSend={onSend}
					onStop={onStop}
					activeMode={activeMode}
					onModeChange={onModeChange}
					composer={composer}
					onRegenerate={onRegenerate}
					onThinkingBudgetChange={onThinkingBudgetChange}
					onAddAttachment={onAddAttachment}
					onRemoveAttachment={onRemoveAttachment}
					onOpenSettings={onOpenSettings}
				/>
			</div>
		</div>
	);
};
