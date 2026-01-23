/**
 * SessionHistory Component
 *
 * Displays a list of chat sessions with options to:
 * - Create new session
 * - Switch between sessions
 * - Delete sessions
 * - Rename sessions
 */

import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import type { Session } from "../../../types";

interface SessionHistoryProps {
	sessions: Session[];
	currentSessionId: string;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
	onRenameSession: (id: string, title: string) => void;
	loading?: boolean;
}

export const SessionHistory: React.FC<SessionHistoryProps> = ({
	sessions,
	currentSessionId,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
	onRenameSession,
	loading = false,
}) => {
	const { t } = useTranslation();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");
	// UX改善3: 削除確認ダイアログ用state
	const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

	const handleStartEdit = (session: Session) => {
		setEditingId(session.id);
		setEditTitle(session.title);
	};

	const handleSaveEdit = () => {
		if (editingId && editTitle.trim()) {
			onRenameSession(editingId, editTitle.trim());
		}
		setEditingId(null);
		setEditTitle("");
	};

	const handleCancelEdit = () => {
		setEditingId(null);
		setEditTitle("");
	};

	const formatDate = (dateStr: string) => {
		const date = new Date(dateStr);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (days === 0) return t("common.today", "Today");
		if (days === 1) return t("common.yesterday", "Yesterday");
		if (days < 7)
			return t("common.daysAgo", "{{count}} days ago", { count: days });
		return date.toLocaleDateString();
	};

	return (
		<div className="flex flex-col h-full bg-[var(--bg-panel)] rounded-lg overflow-hidden">
			{/* Header */}
			<div className="flex justify-between items-center px-4 py-3 border-b border-[var(--border-subtle)]">
				<h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">
					{t("session_history.title", "Sessions")}
				</h3>
				<button
					type="button"
					className="flex items-center justify-center w-7 h-7 border-none rounded-md bg-[var(--text-accent)] text-[var(--bg-app)] cursor-pointer transition-all hover:opacity-90 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
					onClick={onCreateSession}
					disabled={loading}
					aria-label={t("session_history.new", "New Session")}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						aria-hidden="true"
					>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
				</button>
			</div>

			{/* Session List */}
			<ul
				className="flex-1 overflow-y-auto p-2 list-none m-0 custom-scrollbar"
				aria-label={t("session_history.list_aria_label", "Session List")}
			>
				{loading && sessions.length === 0 ? (
					<div className="p-6 text-center text-[var(--text-secondary)] text-sm">
						{t("session_history.loading", "Loading...")}
					</div>
				) : sessions.length === 0 ? (
					<div className="p-6 text-center text-[var(--text-secondary)] text-sm">
						{t("session_history.empty", "No sessions yet")}
					</div>
				) : (
					sessions.map((session) => (
						<li
							key={session.id}
							className={`flex items-stretch mb-1 rounded-lg transition-colors group ${
								session.id === currentSessionId
									? "bg-[var(--glass-highlight)] border-l-[3px] border-[var(--text-accent)]"
									: "bg-transparent hover:bg-[var(--border-subtle)]"
							}`}
						>
							{editingId === session.id ? (
								<div className="flex items-center gap-1 p-2 w-full">
									<input
										type="text"
										value={editTitle}
										onChange={(e) => setEditTitle(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleSaveEdit();
											if (e.key === "Escape") handleCancelEdit();
										}}
										className="flex-1 px-2 py-1.5 border border-[var(--text-accent)] rounded bg-[var(--bg-overlay)] text-[var(--text-primary)] text-sm outline-none"
										aria-label={t(
											"session_history.edit_title",
											"Edit session title",
										)}
										// biome-ignore lint/a11y/noAutofocus: user initiated edit
										autoFocus
									/>
									<button
										type="button"
										onClick={handleSaveEdit}
										className="w-6 h-6 border-none rounded cursor-pointer text-xs flex items-center justify-center bg-[var(--text-accent)] text-[var(--bg-app)]"
										aria-label={t("common.save", "Save")}
									>
										✓
									</button>
									<button
										type="button"
										onClick={handleCancelEdit}
										className="w-6 h-6 border-none rounded cursor-pointer text-xs flex items-center justify-center bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
										aria-label={t("common.cancel", "Cancel")}
									>
										✕
									</button>
								</div>
							) : (
								<>
									<button
										type="button"
										className="flex-1 flex flex-col items-start px-3 py-2.5 border-none bg-transparent text-inherit cursor-pointer text-left min-w-0"
										onClick={() => onSelectSession(session.id)}
										aria-current={
											session.id === currentSessionId ? "true" : "false"
										}
									>
										<div className="text-[13px] font-medium text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis w-full">
											{session.title}
										</div>
										<div className="flex gap-2 text-[11px] text-[var(--text-secondary)] mt-0.5">
											<span>{formatDate(session.updated_at)}</span>
											{session.message_count !== undefined && (
												<span>
													{session.message_count}{" "}
													{t("session_history.messages", "msgs")}
												</span>
											)}
										</div>
										{session.preview && (
											<div className="text-[11px] text-[var(--text-secondary)] opacity-70 whitespace-nowrap overflow-hidden text-ellipsis w-full mt-1">
												{session.preview}
											</div>
										)}
									</button>
									<div className="flex flex-col gap-0.5 p-1 opacity-0 group-hover:opacity-100 transition-opacity">
										<button
											type="button"
											className="w-6 h-6 border-none rounded bg-transparent text-[var(--text-secondary)] cursor-pointer text-xs flex items-center justify-center hover:bg-[var(--border-highlight)] hover:text-[var(--text-primary)]"
											onClick={(e) => {
												e.stopPropagation();
												handleStartEdit(session);
											}}
											aria-label={t("common.edit", "Rename")}
										>
											✎
										</button>
										<button
											type="button"
											className="w-6 h-6 border-none rounded bg-transparent text-[var(--text-secondary)] cursor-pointer text-xs flex items-center justify-center hover:bg-red-500/20 hover:text-red-400"
											onClick={(e) => {
												e.stopPropagation();
												setDeleteTargetId(session.id);
											}}
											aria-label={t("common.delete", "Delete")}
										>
											🗑
										</button>
									</div>
								</>
							)}
						</li>
					))
				)}
			</ul>

			{/* UX改善3: カスタム削除確認ダイアログ */}
			<ConfirmDialog
				isOpen={deleteTargetId !== null}
				title={t("session_history.delete_title", "Delete Session")}
				message={t(
					"session_history.delete_message",
					"Are you sure you want to delete this session? All conversation history will be lost.",
				)}
				confirmLabel={t("common.delete", "Delete")}
				cancelLabel={t("common.cancel", "Cancel")}
				variant="danger"
				onConfirm={() => {
					if (deleteTargetId) {
						onDeleteSession(deleteTargetId);
					}
					setDeleteTargetId(null);
				}}
				onCancel={() => setDeleteTargetId(null)}
			/>
		</div>
	);
};

export default SessionHistory;
