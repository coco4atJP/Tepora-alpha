import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { socketCommands, useChatStore, useSessionStore, useSocketConnectionStore } from "../stores";
import { apiClient } from "../../../utils/api-client";
import { logger } from "../../../utils/logger";

// ── Types ──────────────────────────────────────────────────────────────────

type CompactionStatus = "queued" | "running" | "done" | "failed";

interface CompactionJob {
	id: string;
	session_id: string;
	scope: "CHAR" | "PROF";
	status: CompactionStatus;
	scanned_events: number;
	merged_groups: number;
	replaced_events: number;
	created_events: number;
	created_at: string;
	finished_at?: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_BADGES: Record<CompactionStatus, string> = {
	queued:
		"bg-yellow-500/20 border-yellow-400/40 text-yellow-300",
	running:
		"bg-blue-500/20 border-blue-400/40 text-blue-300",
	done: "bg-emerald-500/20 border-emerald-400/40 text-emerald-300",
	failed: "bg-red-500/20 border-red-400/40 text-red-300",
};

function isActiveStatus(status: CompactionStatus) {
	return status === "queued" || status === "running";
}

function formatDate(iso: string) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

// ── Components ─────────────────────────────────────────────────────────────

const StatItem: React.FC<{ label: string; value: number | string }> = ({
	label,
	value,
}) => (
	<div className="flex justify-between items-center border-b border-gray-700/50 pb-2 last:border-0">
		<span className="text-gray-400">{label}</span>
		<span className="text-white font-mono font-bold">{value}</span>
	</div>
);

const JobRow: React.FC<{ job: CompactionJob }> = ({ job }) => {
	const { t } = useTranslation();
	const elapsed =
		job.finished_at && job.created_at
			? `${((new Date(job.finished_at).getTime() - new Date(job.created_at).getTime()) / 1000).toFixed(1)}s`
			: null;
	return (
		<div className="rounded-lg border border-gray-700 bg-gray-800/60 p-3 text-sm space-y-1.5">
			<div className="flex items-center justify-between gap-2">
				<span
					className={`px-2 py-0.5 rounded border text-xs font-semibold ${STATUS_BADGES[job.status]}`}
				>
					{job.status.toUpperCase()}
				</span>
				<span className="text-gray-500 font-mono text-xs truncate max-w-[160px]">
					{job.id}
				</span>
				<span className="text-gray-400 text-xs ml-auto">
					{formatDate(job.created_at)}
				</span>
			</div>
			{job.status === "done" && (
				<div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-gray-300 pt-1">
					<span>
						{t("settings.memory.compaction.scanned", "Scanned:")}{" "}
						<span className="font-mono text-white">{job.scanned_events}</span>
					</span>
					<span>
						{t("settings.memory.compaction.merged_groups", "Merged groups:")}{" "}
						<span className="font-mono text-white">{job.merged_groups}</span>
					</span>
					<span>
						{t("settings.memory.compaction.replaced", "Replaced:")}{" "}
						<span className="font-mono text-white">{job.replaced_events}</span>
					</span>
					<span>
						{t("settings.memory.compaction.created", "Created:")}{" "}
						<span className="font-mono text-white">{job.created_events}</span>
					</span>
					{elapsed && (
						<span className="col-span-2 text-gray-500 text-xs">
							{t("settings.memory.compaction.elapsed", "Elapsed:")} {elapsed}
						</span>
					)}
				</div>
			)}
			{job.status === "running" && (
				<div className="flex items-center gap-2 text-blue-400 text-xs pt-1">
					<svg
						className="animate-spin h-3 w-3"
						viewBox="0 0 24 24"
						fill="none"
						strokeWidth={2}
						stroke="currentColor"
					>
						<circle
							className="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
						/>
						<path
							className="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z"
						/>
					</svg>
					{t("settings.memory.compaction.compressing", "Compressing...")}
				</div>
			)}
			{job.status === "failed" && (
				<p className="text-red-400 text-xs pt-1">{t("settings.memory.compaction.failed", "Compression failed.")}</p>
			)}
		</div>
	);
};

// ── Main page ──────────────────────────────────────────────────────────────

const Memory: React.FC = () => {
	const memoryStats = useChatStore((state) => state.memoryStats);
	const isConnected = useSocketConnectionStore((state) => state.isConnected);
	const currentSessionId = useSessionStore((state) => state.currentSessionId);
	const { t } = useTranslation();

	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [jobs, setJobs] = useState<CompactionJob[]>([]);
	const [isLoadingJobs, setIsLoadingJobs] = useState(false);
	const hasActiveJobRef = useRef(false);

	// Fetch job history from backend.
	const fetchJobs = useCallback(async () => {
		try {
			setIsLoadingJobs(true);
			const response = await apiClient.get<{ jobs: CompactionJob[] }>(
				`api/memory/compaction_jobs?session_id=${encodeURIComponent(currentSessionId ?? "default")}`,
			);
			setJobs(response?.jobs ?? []);
		} catch (e) {
			logger.warn("Failed to fetch compaction jobs:", e);
		} finally {
			setIsLoadingJobs(false);
		}
	}, [currentSessionId]);

	useEffect(() => {
		hasActiveJobRef.current = jobs.some((job) => isActiveStatus(job.status));
	}, [jobs]);

	// Refresh stats and jobs when connected.
	useEffect(() => {
		if (isConnected) {
			socketCommands.requestStats();
			fetchJobs();
			const interval = setInterval(() => {
				socketCommands.requestStats();
				// Only poll jobs if any are active (queued/running).
				if (hasActiveJobRef.current) {
					void fetchJobs();
				}
			}, 5000);
			return () => clearInterval(interval);
		}
	}, [isConnected, fetchJobs]);

	const handleCompress = async () => {
		try {
			setIsSubmitting(true);
			setErrorMessage(null);

			await apiClient.post<unknown>("api/memory/compress", {
				session_id: currentSessionId,
			});

			// Immediately refresh job list to show the new queued job.
			await fetchJobs();
		} catch (error) {
			logger.error("Memory compression failed:", error);
			setErrorMessage(
				t("settings.memory.compression.failed", "Compression failed"),
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const hasActiveJob = jobs.some((j) => isActiveStatus(j.status));

	return (
		<div className="p-8 h-full overflow-auto">
			{/* Header */}
			<div className="flex flex-wrap items-center justify-between gap-4 mb-6">
				<h1 className="text-3xl font-bold text-white">
					{t("settings.memory.title", "Memory Statistics")}
				</h1>
				<button
					type="button"
					onClick={handleCompress}
					disabled={isSubmitting || hasActiveJob}
					className="px-4 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-200 disabled:opacity-50 transition-colors"
				>
					{hasActiveJob
						? t("settings.memory.compression.running", "Compressing…")
						: isSubmitting
							? t("settings.memory.compression.submitting", "Submitting…")
							: t("settings.memory.compression.button", "Compress Memories")}
				</button>
			</div>

			{errorMessage && (
				<div className="bg-red-500/10 border border-red-500/50 text-red-300 p-3 rounded mb-6">
					{errorMessage}
				</div>
			)}

			{!isConnected && (
				<div className="bg-yellow-500/10 border border-yellow-500 text-yellow-500 p-4 rounded mb-6">
					{t("settings.memory.connecting", "Connecting to memory system…")}
				</div>
			)}

			{/* Memory stat cards */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
				{/* Character Memory */}
				<div className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
					<h2 className="text-xl font-bold text-blue-400 mb-4 border-b border-gray-700 pb-2">
						{t("settings.memory.character_memory", "Character Memory (EM-LLM)")}
					</h2>
					{memoryStats?.character_memory ? (
						<div className="space-y-4">
							<StatItem
								label={t("settings.memory.stats.total_events", "Total Events")}
								value={memoryStats.character_memory.total_events}
							/>
							<StatItem
								label={t("settings.memory.stats.layer_lml", "LML Events")}
								value={memoryStats.character_memory.layer_counts?.lml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.layer_sml", "SML Events")}
								value={memoryStats.character_memory.layer_counts?.sml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_strength", "Mean Strength")}
								value={memoryStats.character_memory.mean_strength?.toFixed(3) ?? "0.000"}
							/>
							<StatItem
								label={t("settings.memory.stats.total_tokens", "Total Tokens")}
								value={memoryStats.character_memory.total_tokens_in_memory}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_event_size", "Mean Event Size")}
								value={memoryStats.character_memory.mean_event_size?.toFixed(1) || "0.0"}
							/>
							{memoryStats.character_memory.surprise_statistics && (
								<>
									<div className="mt-4 pt-4 border-t border-gray-700">
										<p className="text-sm text-gray-400 mb-2">
											{t("settings.memory.stats.surprise_statistics", "Surprise Statistics")}
										</p>
									</div>
									<StatItem
										label={t("settings.memory.stats.mean_surprise", "Mean Surprise")}
										value={memoryStats.character_memory.surprise_statistics.mean?.toFixed(3) || "N/A"}
									/>
									<StatItem
										label={t("settings.memory.stats.max_surprise", "Max Surprise")}
										value={memoryStats.character_memory.surprise_statistics.max?.toFixed(3) || "N/A"}
									/>
								</>
							)}
						</div>
					) : (
						<p className="text-gray-500 italic">
							{t("common.no_data", "No data available")}
						</p>
					)}
				</div>

				{/* Professional Memory */}
				<div className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
					<h2 className="text-xl font-bold text-green-400 mb-4 border-b border-gray-700 pb-2">
						{t("settings.memory.professional_memory", "Professional Memory (EM-LLM)")}
					</h2>
					{memoryStats?.professional_memory ? (
						<div className="space-y-4">
							<StatItem
								label={t("settings.memory.stats.total_events", "Total Events")}
								value={memoryStats.professional_memory.total_events}
							/>
							<StatItem
								label={t("settings.memory.stats.layer_lml", "LML Events")}
								value={memoryStats.professional_memory.layer_counts?.lml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.layer_sml", "SML Events")}
								value={memoryStats.professional_memory.layer_counts?.sml ?? 0}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_strength", "Mean Strength")}
								value={memoryStats.professional_memory.mean_strength?.toFixed(3) ?? "0.000"}
							/>
							<StatItem
								label={t("settings.memory.stats.total_tokens", "Total Tokens")}
								value={memoryStats.professional_memory.total_tokens_in_memory}
							/>
							<StatItem
								label={t("settings.memory.stats.mean_event_size", "Mean Event Size")}
								value={memoryStats.professional_memory.mean_event_size?.toFixed(1) || "0.0"}
							/>
							{memoryStats.professional_memory.surprise_statistics && (
								<>
									<div className="mt-4 pt-4 border-t border-gray-700">
										<p className="text-sm text-gray-400 mb-2">
											{t("settings.memory.stats.surprise_statistics", "Surprise Statistics")}
										</p>
									</div>
									<StatItem
										label={t("settings.memory.stats.mean_surprise", "Mean Surprise")}
										value={memoryStats.professional_memory.surprise_statistics.mean?.toFixed(3) || "N/A"}
									/>
									<StatItem
										label={t("settings.memory.stats.max_surprise", "Max Surprise")}
										value={memoryStats.professional_memory.surprise_statistics.max?.toFixed(3) || "N/A"}
									/>
								</>
							)}
						</div>
					) : (
						<p className="text-gray-500 italic">
							{t("common.no_data", "No data available")}
						</p>
					)}
				</div>
			</div>

			{/* Compaction Job History */}
			<div className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
				<div className="flex items-center justify-between mb-4 border-b border-gray-700 pb-2">
					<h2 className="text-xl font-bold text-purple-400">
						{t("settings.memory.compaction_history", "Compaction Job History")}
					</h2>
					<button
						type="button"
						onClick={fetchJobs}
						disabled={isLoadingJobs}
						className="text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-40"
					>
						{isLoadingJobs ? t("settings.memory.compaction.loading", "Loading...") : t("settings.memory.compaction.refresh", "↺ Refresh")}
					</button>
				</div>
				{jobs.length === 0 ? (
					<p className="text-gray-500 italic text-sm">
						{t(
							"settings.memory.compaction.no_jobs",
							"No compaction jobs yet. Click \"Compress Memories\" to start one.",
						)}
					</p>
				) : (
					<div className="space-y-2 max-h-80 overflow-y-auto pr-1">
						{jobs.map((job) => (
							<JobRow key={job.id} job={job} />
						))}
					</div>
				)}
			</div>
		</div>
	);
};

export default Memory;

