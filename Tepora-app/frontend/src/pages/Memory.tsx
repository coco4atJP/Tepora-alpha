import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore, useSessionStore, useWebSocketStore } from "../stores";
import { apiClient } from "../utils/api-client";

const Memory: React.FC = () => {
	const memoryStats = useChatStore((state) => state.memoryStats);
	const isConnected = useWebSocketStore((state) => state.isConnected);
	const requestStats = useWebSocketStore((state) => state.requestStats);
	const currentSessionId = useSessionStore((state) => state.currentSessionId);
	const { t } = useTranslation();
	const [isCompressing, setIsCompressing] = useState(false);
	const [compressionMessage, setCompressionMessage] = useState<string | null>(null);

	useEffect(() => {
		if (isConnected) {
			requestStats();
			// Poll every 5 seconds
			const interval = setInterval(requestStats, 5000);
			return () => clearInterval(interval);
		}
	}, [isConnected, requestStats]);

	const handleCompress = async () => {
		try {
			setIsCompressing(true);
			setCompressionMessage(null);

			const response = await apiClient.post<{
				result?: {
					merged_groups?: number;
					replaced_events?: number;
					created_events?: number;
				};
			}>("api/memory/compress", {
				session_id: currentSessionId,
			});

			const mergedGroups = response?.result?.merged_groups ?? 0;
			const replacedEvents = response?.result?.replaced_events ?? 0;
			const createdEvents = response?.result?.created_events ?? 0;
			setCompressionMessage(
				t(
					"settings.memory.compression.success",
					`Compression complete: groups=${mergedGroups}, replaced=${replacedEvents}, created=${createdEvents}`,
				),
			);
			requestStats();
		} catch (error) {
			console.error("Memory compression failed:", error);
			setCompressionMessage(t("settings.memory.compression.failed", "Compression failed"));
		} finally {
			setIsCompressing(false);
		}
	};

	return (
		<div className="p-8 h-full overflow-auto">
			<div className="flex flex-wrap items-center justify-between gap-4 mb-6">
				<h1 className="text-3xl font-bold text-white">
					{t("settings.memory.title", "Memory Statistics")}
				</h1>
				<button
					type="button"
					onClick={handleCompress}
					disabled={isCompressing}
					className="px-4 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-200 disabled:opacity-50"
				>
					{isCompressing
						? t("settings.memory.compression.running", "Compressing...")
						: t("settings.memory.compression.button", "Compress Memories")}
				</button>
			</div>

			{compressionMessage && (
				<div className="bg-slate-700/50 border border-slate-500/50 text-slate-200 p-3 rounded mb-6">
					{compressionMessage}
				</div>
			)}

			{!isConnected && (
				<div className="bg-yellow-500/10 border border-yellow-500 text-yellow-500 p-4 rounded mb-6">
					{t("settings.memory.connecting", "Connecting to memory system...")}
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				{/* Character Memory */}
				<div className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
					<h2 className="text-xl font-bold text-blue-400 mb-4 border-b border-gray-700 pb-2">
						{t("settings.memory.character_memory", "Character Memory (EM-LLM)")}
					</h2>
					{memoryStats?.char_memory ? (
						<div className="space-y-4">
							<StatItem label={t("settings.memory.stats.total_events", "Total Events")} value={memoryStats.char_memory.total_events} />
							<StatItem
								label={t("settings.memory.stats.layer_lml", "LML Events")}
								value={memoryStats.char_memory.layer_counts?.lml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.layer_sml", "SML Events")}
								value={memoryStats.char_memory.layer_counts?.sml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_strength", "Mean Strength")}
								value={memoryStats.char_memory.mean_strength?.toFixed(3) ?? "0.000"}
							/>
							<StatItem
								label={t("settings.memory.stats.total_tokens", "Total Tokens")}
								value={memoryStats.char_memory.total_tokens_in_memory}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_event_size", "Mean Event Size")}
								value={memoryStats.char_memory.mean_event_size?.toFixed(1) || "0.0"}
							/>
							{memoryStats.char_memory.surprise_statistics && (
								<>
									<div className="mt-4 pt-4 border-t border-gray-700">
										<p className="text-sm text-gray-400 mb-2">{t("settings.memory.stats.surprise_statistics", "Surprise Statistics")}</p>
									</div>
									<StatItem
										label={t("settings.memory.stats.mean_surprise", "Mean Surprise")}
										value={memoryStats.char_memory.surprise_statistics.mean?.toFixed(3) || "N/A"}
									/>
									<StatItem
										label={t("settings.memory.stats.max_surprise", "Max Surprise")}
										value={memoryStats.char_memory.surprise_statistics.max?.toFixed(3) || "N/A"}
									/>
								</>
							)}
						</div>
					) : (
						<p className="text-gray-500 italic">{t("common.no_data", "No data available")}</p>
					)}
				</div>

				{/* Professional Memory */}
				<div className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
					<h2 className="text-xl font-bold text-green-400 mb-4 border-b border-gray-700 pb-2">
						{t("settings.memory.professional_memory", "Professional Memory (EM-LLM)")}
					</h2>
					{memoryStats?.prof_memory ? (
						<div className="space-y-4">
							<StatItem label={t("settings.memory.stats.total_events", "Total Events")} value={memoryStats.prof_memory.total_events} />
							<StatItem
								label={t("settings.memory.stats.layer_lml", "LML Events")}
								value={memoryStats.prof_memory.layer_counts?.lml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.layer_sml", "SML Events")}
								value={memoryStats.prof_memory.layer_counts?.sml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_strength", "Mean Strength")}
								value={memoryStats.prof_memory.mean_strength?.toFixed(3) ?? "0.000"}
							/>
							<StatItem
								label={t("settings.memory.stats.total_tokens", "Total Tokens")}
								value={memoryStats.prof_memory.total_tokens_in_memory}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_event_size", "Mean Event Size")}
								value={memoryStats.prof_memory.mean_event_size?.toFixed(1) || "0.0"}
							/>
							{memoryStats.prof_memory.surprise_statistics && (
								<>
									<div className="mt-4 pt-4 border-t border-gray-700">
										<p className="text-sm text-gray-400 mb-2">{t("settings.memory.stats.surprise_statistics", "Surprise Statistics")}</p>
									</div>
									<StatItem
										label={t("settings.memory.stats.mean_surprise", "Mean Surprise")}
										value={memoryStats.prof_memory.surprise_statistics.mean?.toFixed(3) || "N/A"}
									/>
									<StatItem
										label={t("settings.memory.stats.max_surprise", "Max Surprise")}
										value={memoryStats.prof_memory.surprise_statistics.max?.toFixed(3) || "N/A"}
									/>
								</>
							)}
						</div>
					) : (
						<p className="text-gray-500 italic">{t("common.no_data", "No data available")}</p>
					)}
				</div>
			</div>
		</div>
	);
};

const StatItem: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
	<div className="flex justify-between items-center border-b border-gray-700/50 pb-2 last:border-0">
		<span className="text-gray-400">{label}</span>
		<span className="text-white font-mono font-bold">{value}</span>
	</div>
);

export default Memory;
