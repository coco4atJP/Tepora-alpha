import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../shared/ui/ConfirmDialog";
import type { SessionSidebarViewProps } from "./props";

function formatSessionTime(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

export const SessionSidebarView: React.FC<SessionSidebarViewProps> = ({
	state,
	sessions,
	errorMessage,
	pendingSessionId,
	onSelectSession,
	onCreateSession,
	onRenameSession,
	onDeleteSession,
}) => {
	const { t } = useTranslation();
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [titleDraft, setTitleDraft] = useState("");
	const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

	const deleteTarget = useMemo(
		() => sessions.find((session) => session.id === deleteTargetId) ?? null,
		[deleteTargetId, sessions],
	);

	return (
		<div className="flex h-full flex-col overflow-hidden text-text-main">
			<div className="mb-8 flex items-center justify-between gap-4">
				<div>
					<div className="font-serif text-[1.8rem] text-primary tracking-[0.08em] italic">
						{t("v2.session.historyTitle", "History")}
					</div>
					<div className="mt-2 text-xs uppercase tracking-[0.18em] text-text-muted">
						{t("v2.session.historySubtitle", "Sessions")}
					</div>
				</div>
			</div>

			<button
				type="button"
				onClick={() => void onCreateSession()}
				disabled={state === "loading"}
				className="mb-8 flex w-full items-center justify-center gap-3 rounded-[30px] border border-primary/30 bg-transparent px-5 py-3 text-[0.95rem] text-primary transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-primary/5 hover:shadow-[0_4px_12px_rgba(140,101,62,0.12)] disabled:opacity-50"
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<line x1="12" y1="5" x2="12" y2="19" />
					<line x1="5" y1="12" x2="19" y2="12" />
				</svg>
				{t("v2.session.newSession", "New Session")}
			</button>

			{errorMessage ? (
				<div className="mb-4 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
					{errorMessage}
				</div>
			) : null}

			<div className="custom-scrollbar -mr-2 flex flex-1 flex-col gap-3 overflow-y-auto pr-2">
				{state === "loading" && sessions.length === 0 ? (
					<div className="px-4 text-sm text-text-muted">
						{t("v2.common.loading", "Loading...")}
					</div>
				) : sessions.length === 0 ? (
					<div className="px-4 text-sm text-text-muted/70">
						{t("v2.session.empty", "No history yet.")}
					</div>
				) : (
					sessions.map((session) => {
						const isEditing = editingSessionId === session.id;
						const isPending = pendingSessionId === session.id;
						return (
							<div
								key={session.id}
								className={`group rounded-[20px] border px-4 py-3 transition-all ${
									session.isSelected
										? "border-primary/20 bg-white/65 shadow-[0_10px_25px_rgba(92,58,33,0.08)]"
										: "border-transparent bg-white/35 hover:border-primary/15 hover:bg-white/60"
								}`}
							>
								<div className="flex items-start gap-3">
									<button
										type="button"
										onClick={() => onSelectSession(session.id)}
										className="min-w-0 flex-1 text-left"
									>
										<div className="flex items-center justify-between gap-3">
											<div className="truncate text-[0.95rem] font-medium text-text-main">
												{session.title}
											</div>
											<div className="shrink-0 text-[0.68rem] uppercase tracking-[0.18em] text-text-muted">
												{formatSessionTime(session.updatedAt)}
											</div>
										</div>
										<div className="mt-2 max-h-[3rem] overflow-hidden text-sm leading-6 text-text-muted">
											{session.preview ??
												t("v2.session.previewFallback", "No preview yet")}
										</div>
									</button>

									<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
										<button
											type="button"
											className="rounded-full border border-white/10 px-2.5 py-1 text-[0.68rem] uppercase tracking-[0.14em] text-text-muted transition-colors hover:border-primary/20 hover:text-primary"
											onClick={() => {
												setEditingSessionId(session.id);
												setTitleDraft(session.title);
											}}
											disabled={isPending}
										>
											{t("v2.session.rename", "Rename")}
										</button>
										<button
											type="button"
											className="rounded-full border border-red-400/20 px-2.5 py-1 text-[0.68rem] uppercase tracking-[0.14em] text-red-300 transition-colors hover:bg-red-500/10"
											onClick={() => setDeleteTargetId(session.id)}
											disabled={isPending}
										>
											{t("v2.session.delete", "Delete")}
										</button>
									</div>
								</div>

								{isEditing ? (
									<form
										className="mt-3 flex items-center gap-2"
										onSubmit={(event) => {
											event.preventDefault();
											const nextTitle = titleDraft.trim();
											if (!nextTitle) {
												return;
											}
											void onRenameSession(session.id, nextTitle).then(() => {
												setEditingSessionId(null);
											});
										}}
									>
										<input
											autoFocus
											value={titleDraft}
											onChange={(event) => setTitleDraft(event.target.value)}
											className="min-w-0 flex-1 rounded-full border border-primary/20 bg-white/80 px-4 py-2 text-sm text-text-main outline-none transition-colors focus:border-primary/40"
										/>
										<button
											type="submit"
											className="rounded-full border border-primary/20 px-3 py-2 text-xs uppercase tracking-[0.14em] text-primary transition-colors hover:bg-primary/5"
											disabled={isPending || !titleDraft.trim()}
										>
											{isPending ? t("v2.common.saving", "Saving...") : t("v2.common.save", "Save")}
										</button>
										<button
											type="button"
											className="rounded-full border border-white/10 px-3 py-2 text-xs uppercase tracking-[0.14em] text-text-muted transition-colors hover:text-text-main"
											onClick={() => {
												setEditingSessionId(null);
												setTitleDraft("");
											}}
										>
											{t("v2.common.cancel", "Cancel")}
										</button>
									</form>
								) : null}
							</div>
						);
					})
				)}
			</div>

			<ConfirmDialog
				isOpen={Boolean(deleteTarget)}
				title={t("v2.session.deleteTitle", "Delete session")}
				message={
					deleteTarget
						? t(
							"v2.session.deleteMessage",
							"Delete this session and remove all messages from history?",
						  )
						: ""
				}
				variant="danger"
				confirmLabel={t("v2.session.delete", "Delete")}
				cancelLabel={t("v2.common.cancel", "Cancel")}
				onCancel={() => setDeleteTargetId(null)}
				onConfirm={() => {
					if (!deleteTarget) {
						return;
					}
					void onDeleteSession(deleteTarget.id).then(() => {
						setDeleteTargetId(null);
					});
				}}
			/>
		</div>
	);
};
