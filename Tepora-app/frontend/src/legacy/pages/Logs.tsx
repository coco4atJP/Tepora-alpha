import { RefreshCcw } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../utils/api-client";

const Logs: React.FC = () => {
	const { t } = useTranslation();
	const [logs, setLogs] = useState<string[]>([]);
	const [selectedLog, setSelectedLog] = useState<string | null>(null);
	const [logContent, setLogContent] = useState<string>("");
	const [loading, setLoading] = useState(true);
	const [contentLoading, setContentLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchLogs = useCallback(async () => {
		try {
			const data = await apiClient.get<{ logs: string[] }>("api/logs");
			setLogs(data.logs);
			setLoading(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("logs.unknown_error", "An error occurred"));
			setLoading(false);
		}
	}, [t]);

	const fetchLogContent = useCallback(
		async (filename: string) => {
			setContentLoading(true);
			try {
				const data = await apiClient.get<{ content: string }>(`api/logs/${filename}`);
				setLogContent(data.content);
				setContentLoading(false);
			} catch (err) {
				setLogContent(
					`${t("logs.error_content", "Error loading log content")}: ${err instanceof Error ? err.message : t("logs.unknown_error", "Unknown error")}`,
				);
				setContentLoading(false);
			}
		},
		[t],
	);

	// 初回ロード
	useEffect(() => {
		fetchLogs();
	}, [fetchLogs]);

	// ログ一覧が更新され、かつ未選択の場合に最初のログを選択
	useEffect(() => {
		if (logs.length > 0 && !selectedLog) {
			setSelectedLog(logs[0]);
		}
	}, [logs, selectedLog]);

	useEffect(() => {
		if (selectedLog) {
			fetchLogContent(selectedLog);
		}
	}, [selectedLog, fetchLogContent]);

	if (loading)
		return <div className="bg-bg/40 p-8 text-text-main">{t("logs.loading_logs", "Loading logs...")}</div>;

	return (
		<div className="flex h-full bg-bg/40 text-text-main">
			{/* Sidebar List */}
			<div className="flex w-64 flex-col border-r border-border/60 bg-surface/40">
				<div className="border-b border-border/60 p-4">
					<h2 className="font-serif text-xl text-text-main">{t("logs.title", "Log Files")}</h2>
					<button
						type="button"
						onClick={fetchLogs}
						className="mt-2 flex items-center gap-1 text-xs text-primary transition-colors hover:text-secondary"
					>
						<RefreshCcw className="w-3.5 h-3.5" aria-hidden="true" />
						{t("logs.refresh", "Refresh List")}
					</button>
				</div>
				<div className="flex-1 overflow-y-auto">
					{logs.map((log) => (
						<button
							type="button"
							key={log}
							onClick={() => setSelectedLog(log)}
							className={`w-full text-left px-4 py-3 text-sm truncate transition-colors ${
								selectedLog === log
									? "border-r-2 border-primary/40 bg-primary/10 text-text-main"
									: "text-text-muted hover:bg-surface/80 hover:text-text-main"
							}`}
						>
							{log}
						</button>
					))}
					{logs.length === 0 && (
						<div className="p-4 text-center text-sm text-text-muted">
							{t("logs.no_logs", "No logs found")}
						</div>
					)}
				</div>
			</div>

			{/* Main Content */}
			<div className="flex-1 flex flex-col min-w-0">
				{error && (
					<div className="border-b border-semantic-error/40 bg-semantic-error/10 p-2 text-center text-sm text-semantic-error">
						{error}
					</div>
				)}
				<div className="flex items-center justify-between border-b border-border/60 bg-surface/40 p-4">
					<h2 className="truncate font-serif text-lg text-text-main">
						{selectedLog || t("logs.select_log", "Select a log")}
					</h2>
					{selectedLog && (
						<button
							type="button"
							onClick={() => fetchLogContent(selectedLog)}
							className="rounded-md border border-border/60 bg-surface/70 px-3 py-1 text-sm text-text-muted transition-colors hover:border-primary/20 hover:bg-surface hover:text-text-main"
						>
							{t("logs.refresh_content", "Refresh Content")}
						</button>
					)}
				</div>

				<div className="flex-1 p-4 overflow-hidden relative">
					{contentLoading && (
						<div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
							<div className="text-primary">{t("logs.loading_content", "Loading content...")}</div>
						</div>
					)}
					<div className="h-full overflow-auto rounded-xl border border-border/60 bg-surface/70 p-4 font-mono text-xs whitespace-pre-wrap text-text-muted">
						{logContent || t("logs.select_to_view", "Select a log file to view its content.")}
					</div>
				</div>
			</div>
		</div>
	);
};

export default Logs;
