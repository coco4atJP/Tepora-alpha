import { FileText, RefreshCw, Scroll } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../../../utils/api-client";
import { SettingsSection } from "../SettingsComponents";

interface LogListResponse {
	logs: string[];
}

interface LogContentResponse {
	content: string;
}

const SystemLogsSettings: React.FC = () => {
	const { t } = useTranslation();
	const [logs, setLogs] = useState<string[]>([]);
	const [selectedLog, setSelectedLog] = useState<string | null>(null);
	const [logContent, setLogContent] = useState<string>("");
	const [loadingLogs, setLoadingLogs] = useState(false);
	const [loadingContent, setLoadingContent] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchLogs = useCallback(async () => {
		try {
			setLoadingLogs(true);
			setError(null);
			const data = await apiClient.get<LogListResponse>("api/logs");
			setLogs(data.logs);
			if (data.logs.length > 0 && !selectedLog) {
				// Optionally select the first log automatically?
				// setSelectedLog(data.logs[0]);
			}
		} catch (err) {
			console.error("Failed to fetch logs:", err);
			setError(t("logs.error_fetch"));
		} finally {
			setLoadingLogs(false);
		}
	}, [selectedLog, t]);

	const fetchLogContent = useCallback(
		async (filename: string) => {
			try {
				setLoadingContent(true);
				const data = await apiClient.get<LogContentResponse>(
					`api/logs/${filename}`,
				);
				setLogContent(data.content);
			} catch (err) {
				console.error("Failed to fetch log content:", err);
				setLogContent(t("logs.error_content"));
			} finally {
				setLoadingContent(false);
			}
		},
		[t],
	);

	useEffect(() => {
		fetchLogs();
	}, [fetchLogs]);

	useEffect(() => {
		if (selectedLog) {
			fetchLogContent(selectedLog);
		} else {
			setLogContent("");
		}
	}, [selectedLog, fetchLogContent]);

	const handleRefresh = () => {
		fetchLogs();
		if (selectedLog) {
			fetchLogContent(selectedLog);
		}
	};

	return (
		<SettingsSection
			title={t("logs.title")}
			icon={<Scroll size={18} />}
			description={t("logs.select_to_view")}
		>
			<div className="flex flex-col h-[600px] gap-4">
				{/* Controls */}
				<div className="flex justify-end">
					<button
						type="button"
						onClick={handleRefresh}
						disabled={loadingLogs || loadingContent}
						className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-sm transition-colors flex items-center gap-2"
					>
						<RefreshCw
							size={14}
							className={loadingLogs || loadingContent ? "animate-spin" : ""}
						/>
						{t("logs.refresh")}
					</button>
				</div>

				{/* Main Content */}
				<div className="flex-1 flex gap-4 min-h-0">
					{/* Log List */}
					<div className="w-1/3 flex flex-col gap-2 min-h-0 bg-black/20 rounded-lg p-2 border border-white/5">
						<div className="text-xs font-medium text-gray-500 px-2 py-1 uppercase tracking-wider">
							{t("logs.title")}
						</div>
						{error && <div className="px-2 py-2 text-xs text-red-400">{error}</div>}
						<div className="overflow-y-auto flex-1 space-y-1 pr-1 custom-scrollbar">
							{loadingLogs ? (
								<div className="text-center py-4 text-gray-500 text-sm">
									{t("logs.loading_logs")}
								</div>
							) : logs.length === 0 ? (
								<div className="text-center py-4 text-gray-500 text-sm">
									{t("logs.no_logs")}
								</div>
							) : (
								logs.map((log) => (
									<button
										key={log}
										type="button"
										onClick={() => setSelectedLog(log)}
										className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors truncate ${
											selectedLog === log
												? "bg-gold-500/10 text-gold-400 border border-gold-500/20"
												: "text-gray-400 hover:bg-white/5 hover:text-gray-200"
										}`}
									>
										<div className="flex items-center gap-2">
											<FileText size={14} className="shrink-0 opacity-70" />
											<span className="truncate">{log}</span>
										</div>
									</button>
								))
							)}
						</div>
					</div>

					{/* Log Content */}
					<div className="w-2/3 flex flex-col min-h-0 bg-black/40 rounded-lg border border-white/10">
						<div className="px-4 py-2 border-b border-white/5 flex items-center justify-between">
							<span className="text-sm font-medium text-gray-300">
								{selectedLog || t("logs.select_log")}
							</span>
							{selectedLog && (
								<span className="text-xs text-gray-500">
									{/* Maybe file size or date if available */}
								</span>
							)}
						</div>
						<div className="flex-1 overflow-auto p-4 custom-scrollbar bg-[#050505]">
							{loadingContent ? (
								<div className="flex items-center justify-center h-full text-gray-500">
									<RefreshCw className="animate-spin mr-2" size={16} />
									{t("logs.loading_content")}
								</div>
							) : selectedLog ? (
								<pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap break-all leading-relaxed">
									{logContent}
								</pre>
							) : (
								<div className="flex items-center justify-center h-full text-gray-600 text-sm">
									{t("logs.select_to_view")}
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		</SettingsSection>
	);
};

export default SystemLogsSettings;
