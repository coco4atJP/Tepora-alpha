import React from "react";
import { useTranslation } from "react-i18next";
import type { ChatScreenViewProps } from "./props";
import { ChatMessageList } from "./ChatMessageList";
import { CommandArea } from "./CommandArea";
import { QuickCharacterSwitcher } from "./QuickCharacterSwitcher";

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
	onSearchModeChange,
	onThinkingBudgetChange,
	onAddAttachment,
	onRemoveAttachment,
	onOpenSettings,
	onOpenLeftSidebar,
	onOpenRightSidebar,
	shellState,
	connectionState,
	statusMessage,
	toolConfirmation,
	onToolDecision,
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
					<QuickCharacterSwitcher />
					<button
						type="button"
						onClick={onOpenRightSidebar}
						className="flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--glass-border)] bg-[var(--glass-bg)] text-text-muted shadow-[var(--glass-shadow)] backdrop-blur-md transition-all hover:bg-surface/80 hover:text-primary"
						title={t("v2.settings.open", "Open settings")}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.7-1 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.4.1Z" />
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

			{toolConfirmation ? (
				<div className="absolute right-6 top-24 z-[55] w-[min(360px,calc(100%-3rem))] rounded-[24px] border border-primary/20 bg-surface/95 p-4 text-sm leading-7 text-text-muted shadow-[0_24px_60px_rgba(59,38,20,0.16)] backdrop-blur-xl">
					<div className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-primary/65">
						{t("v2.agent.approvalRequired", "Approval required")}
					</div>
					<div className="text-base font-medium text-text-main">
						{toolConfirmation.toolName}
					</div>
					<div className="mt-2 text-xs uppercase tracking-[0.14em] text-primary/75">
						{toolConfirmation.riskLevel} {t("v2.agent.risk", "risk")}
					</div>
					{toolConfirmation.description ? (
						<p className="mt-3">{toolConfirmation.description}</p>
					) : null}
					<p className="mt-3">{toolConfirmation.scopeLabel}</p>
					<pre className="mt-3 max-h-40 overflow-auto rounded-2xl bg-black/25 p-3 text-xs text-text-main/85">
						{toolConfirmation.argsPreview}
					</pre>
					<div className="mt-4 flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => void onToolDecision("deny")}
							className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-text-main transition-colors hover:border-primary/30 hover:text-primary"
						>
							{t("v2.agent.deny", "Deny")}
						</button>
						<button
							type="button"
							onClick={() => void onToolDecision("once")}
							className="rounded-full border border-primary/25 px-3 py-1.5 text-xs text-primary transition-colors hover:border-primary/40"
						>
							{t("v2.agent.approveOnce", "Approve once")}
						</button>
						{toolConfirmation.expiryOptions[0] ? (
							<button
								type="button"
								onClick={() =>
									void onToolDecision(
										"always_until_expiry",
										toolConfirmation.expiryOptions[0],
									)
								}
								className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-text-main transition-colors hover:border-primary/30 hover:text-primary"
							>
								{t("v2.agent.allowTemporary", "Allow temporarily")}
							</button>
						) : null}
					</div>
				</div>
			) : null}

			<ChatMessageList
				messages={messages}
				isEmpty={messages.length === 0}
				onRegenerate={onRegenerate}
			/>

			<div className="absolute bottom-10 left-1/2 z-50 w-full max-w-[800px] -translate-x-1/2 px-5">
				<CommandArea
					draft={draft}
					onDraftChange={onDraftChange}
					onSend={onSend}
					onStop={onStop}
					activeMode={activeMode}
					onModeChange={onModeChange}
					onSearchModeChange={onSearchModeChange}
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
