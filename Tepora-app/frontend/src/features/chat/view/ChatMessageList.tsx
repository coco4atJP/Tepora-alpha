import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useV2ConfigQuery } from "../../settings/model/queries";
import { logger } from "../../../utils/logger";
import type { ChatMessageViewModel } from "./props";

export interface ChatMessageListProps {
	messages: ChatMessageViewModel[];
	isEmpty: boolean;
	onRegenerate: () => Promise<void>;
}

export const ChatMessageList: React.FC<ChatMessageListProps> = ({
	messages,
	isEmpty,
	onRegenerate,
}) => {
	const { t } = useTranslation();
	const { data: config } = useV2ConfigQuery();
	const [openMenuId, setOpenMenuId] = useState<string | null>(null);
	const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
	const menuRefs = useRef<Record<string, HTMLDivElement | null>>({});
	const copiedResetTimerRef = useRef<number | null>(null);
	const assistantName = useMemo(() => {
		if (!config?.characters || typeof config.characters !== "object") {
			return t("v2.chat.assistantFallback", "Assistant");
		}

		const activeProfileId =
			typeof config.active_character === "string"
				? config.active_character
				: typeof config.active_character === "string"
				? config.active_character
				: undefined;
		const activeCharacter = activeProfileId
			? (config.characters as Record<string, Record<string, unknown>>)[activeProfileId]
			: undefined;

		if (activeCharacter?.name) {
			return String(activeCharacter.name);
		}

		const firstCharacter = Object.values(
			config.characters as Record<string, Record<string, unknown>>,
		)[0];
		return firstCharacter?.name
			? String(firstCharacter.name)
			: t("v2.chat.assistantFallback", "Assistant");
	}, [config?.active_character, config?.characters, t]);
	const latestRegeneratableMessageId = useMemo(
		() =>
			[...messages]
				.reverse()
				.find(
					(message) =>
						(message.role === "assistant" || message.role === "system") &&
						message.status === "complete",
				)?.id ?? null,
		[messages],
	);

	useEffect(() => {
		if (!openMenuId) {
			return;
		}

		const handlePointerDown = (event: MouseEvent) => {
			const currentMenu = menuRefs.current[openMenuId];
			if (currentMenu?.contains(event.target as Node)) {
				return;
			}
			setOpenMenuId(null);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpenMenuId(null);
			}
		};

		document.addEventListener("mousedown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);

		return () => {
			document.removeEventListener("mousedown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [openMenuId]);

	useEffect(
		() => () => {
			if (copiedResetTimerRef.current !== null) {
				window.clearTimeout(copiedResetTimerRef.current);
			}
		},
		[],
	);

	const handleCopyMessage = async (message: ChatMessageViewModel) => {
		try {
			await navigator.clipboard.writeText(message.content);
			setCopiedMessageId(message.id);
			setOpenMenuId(null);
			if (copiedResetTimerRef.current !== null) {
				window.clearTimeout(copiedResetTimerRef.current);
			}
			copiedResetTimerRef.current = window.setTimeout(() => {
				setCopiedMessageId((current) => (current === message.id ? null : current));
				copiedResetTimerRef.current = null;
			}, 2000);
		} catch (error) {
			logger.error("[ChatMessageList] Failed to copy message", error);
		}
	};

	return (
		<div className="custom-scrollbar flex h-full flex-1 flex-col items-center gap-14 overflow-y-auto px-5 pb-[180px] pt-[100px] lg:px-8 [mask-image:linear-gradient(to_bottom,transparent_0%,black_8%,black_100%)]">
			{isEmpty ? (
				<div className="flex flex-1 flex-col items-center justify-center text-center">
					<div className="font-serif text-3xl italic text-primary">{assistantName}</div>
					<div className="mt-4 text-sm uppercase tracking-[0.25em] text-text-muted">
						{t("v2.chat.emptyState", "How can I help today?")}
					</div>
				</div>
			) : (
				messages.map((message) => (
					<div
						key={message.id}
						className={`group/message relative flex w-full max-w-[860px] gap-6 text-[1rem] leading-8 text-text-main animate-slide-up ${
							message.role === "user" ? "justify-end" : "justify-start"
						}`}
					>
						<div className="absolute right-0 top-0 z-20">
							<div
								ref={(node) => {
									menuRefs.current[message.id] = node;
								}}
								className="relative flex items-center gap-2"
							>
								{copiedMessageId === message.id ? (
									<span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-primary">
										{t("v2.chat.copied", "Copied")}
									</span>
								) : null}
								<button
									type="button"
									aria-label={t("v2.chat.moreActions", "More actions")}
									aria-expanded={openMenuId === message.id}
									className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-surface/70 text-text-muted backdrop-blur-sm transition-colors hover:text-primary"
									onClick={() =>
										setOpenMenuId((current) =>
											current === message.id ? null : message.id,
										)
									}
									title={t("v2.chat.moreActions", "More actions")}
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
										<circle cx="5" cy="12" r="2" />
										<circle cx="12" cy="12" r="2" />
										<circle cx="19" cy="12" r="2" />
									</svg>
								</button>
								{openMenuId === message.id ? (
									<div
										role="menu"
										className="absolute right-0 top-full mt-2 min-w-[10rem] rounded-[20px] border border-border bg-bg/95 p-2 shadow-[0_20px_50px_rgba(59,38,20,0.12)] backdrop-blur-xl"
									>
										<button
											type="button"
											role="menuitem"
											className="flex w-full items-center gap-2 rounded-[14px] px-3 py-2 text-left text-sm text-text-main transition-colors hover:bg-surface/60"
											onClick={() => {
												void handleCopyMessage(message);
											}}
										>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
												<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
												<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
											</svg>
											{t("v2.chat.copy", "Copy")}
										</button>
										{message.id === latestRegeneratableMessageId ? (
											<button
												type="button"
												role="menuitem"
												className="flex w-full items-center gap-2 rounded-[14px] px-3 py-2 text-left text-sm text-text-main transition-colors hover:bg-surface/60"
												onClick={() => {
													setOpenMenuId(null);
													void onRegenerate();
												}}
											>
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
													<polyline points="23 4 23 10 17 10" />
													<polyline points="1 20 1 14 7 14" />
													<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
												</svg>
												{t("v2.chat.regenerate", "Regenerate")}
											</button>
										) : null}
									</div>
								) : null}
							</div>
						</div>

						{message.role === "user" ? (
							<div className="rounded-[26px] rounded-tr-[10px] border border-primary/10 bg-white/70 px-7 py-4 text-[0.98rem] font-medium text-text-main shadow-[0_8px_18px_rgba(59,38,20,0.05)]">
								{message.content}
							</div>
						) : (
							<div className="flex w-full flex-col">
								<div className="mb-4 flex items-center gap-4 font-serif text-[1.28rem] italic tracking-wide text-primary">
									<span>{message.agentName || assistantName}</span>
									{message.mode && message.mode !== "chat" ? (
										<span className="rounded-full border border-secondary/20 bg-secondary/10 px-2.5 py-0.5 text-[0.65rem] font-sans uppercase tracking-widest not-italic text-secondary">
											{message.mode}
										</span>
									) : null}
									{message.status === "streaming" ? (
										<span className="ml-2 flex items-center gap-2 text-[0.65rem] font-sans uppercase tracking-[0.18em] not-italic text-primary/70">
											<span className="flex gap-1.5">
												<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/40" style={{ animationDelay: "0ms" }} />
												<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/40" style={{ animationDelay: "120ms" }} />
												<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/40" style={{ animationDelay: "240ms" }} />
											</span>
											{t("v2.chat.generating", "Generating")}
										</span>
									) : null}
								</div>
								<div className="flex flex-col gap-4 border-l border-primary/18 pl-6 text-text-main">
									{message.thinking ? (
										<details className="group cursor-pointer text-sm text-text-muted/80 transition-colors hover:text-text-muted">
										<summary className="flex select-none items-center gap-2 outline-none">
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
													<circle cx="12" cy="12" r="10" />
													<path d="M12 16v-4" />
													<path d="M12 8h.01" />
												</svg>
												<span className="font-serif text-sm italic">
													{t("v2.chat.thinking", "Reasoning trace")}
												</span>
											</summary>
											<div className="mt-3 whitespace-pre-wrap border-l border-border/40 pl-5 font-mono text-xs leading-6 opacity-85">
												{message.thinking}
											</div>
										</details>
									) : null}
									<div className="whitespace-pre-wrap font-medium leading-8 tracking-[0.01em] text-text-main">
										{message.content}
									</div>
								</div>
							</div>
						)}
					</div>
				))
			)}
		</div>
	);
};
