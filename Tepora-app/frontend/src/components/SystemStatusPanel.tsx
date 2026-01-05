import { Activity, Cpu, Database, MessageSquare } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryStats, SystemStatus } from "../types";
import { getApiBase, getAuthHeaders } from "../utils/api";

interface SystemStatusPanelProps {
	isConnected: boolean;
	memoryStats: MemoryStats | null;
}

const SystemStatusPanel: React.FC<SystemStatusPanelProps> = ({
	isConnected,
	memoryStats,
}) => {
	const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
	const { t } = useTranslation();

	useEffect(() => {
		const fetchStatus = async () => {
			try {
				const response = await fetch(`${getApiBase()}/api/status`, {
					headers: { ...getAuthHeaders() },
				});
				const data = await response.json();
				setSystemStatus(data);
			} catch (error) {
				console.error("Failed to fetch system status:", error);
			}
		};

		fetchStatus();
		const interval = setInterval(fetchStatus, 30000);
		return () => clearInterval(interval);
	}, []);

	const totalMemoryEvents =
		(memoryStats?.char_memory?.total_events || 0) +
		(memoryStats?.prof_memory?.total_events || 0);

	return (
		<div className="glass-panel p-5 w-full rounded-2xl animate-fade-in mt-auto backdrop-blur-xl border border-gold-500/10 shadow-2xl">
			{/* Header */}
			<div className="flex items-center gap-2 mb-4 pb-3 border-b border-white/5">
				<Activity className="w-4 h-4 text-gold-400" />
				<h3 className="text-gold-300 text-xs font-bold uppercase tracking-[0.2em] flex-1 font-display">
					{t("status.title")}
				</h3>
				<div
					className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-400 animate-pulse" : "bg-red-400"}`}
				/>
			</div>

			{/* Status Items */}
			<div className="space-y-3">
				{/* Network Status */}
				<div className="flex items-center justify-between group hover:bg-white/5 rounded-lg p-2 -m-2 transition-all duration-200">
					<div className="flex items-center gap-2.5">
						<div
							className={`w-7 h-7 rounded-lg flex items-center justify-center ${
								isConnected
									? "bg-green-500/10 text-green-400"
									: "bg-red-500/10 text-red-400"
							}`}
						>
							<Cpu className="w-3.5 h-3.5" />
						</div>
						<span className="text-[11px] text-gray-400 font-medium">
							{t("status.network")}
						</span>
					</div>
					<span
						className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
							isConnected
								? "text-green-400 bg-green-500/10"
								: "text-red-400 bg-red-500/10"
						}`}
					>
						{isConnected ? t("status.connected") : t("status.disconnected")}
					</span>
				</div>

				{/* System Initialized */}
				{systemStatus && (
					<div className="flex items-center justify-between group hover:bg-white/5 rounded-lg p-2 -m-2 transition-all duration-200">
						<div className="flex items-center gap-2.5">
							<div
								className={`w-7 h-7 rounded-lg flex items-center justify-center ${
									systemStatus.initialized
										? "bg-blue-500/10 text-blue-400"
										: "bg-gray-500/10 text-gray-400"
								}`}
							>
								<Activity className="w-3.5 h-3.5" />
							</div>
							<span className="text-[11px] text-gray-400 font-medium">
								{t("status.core_system")}
							</span>
						</div>
						<span
							className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
								systemStatus.initialized
									? "text-blue-400 bg-blue-500/10"
									: "text-gray-400 bg-gray-500/10"
							}`}
						>
							{systemStatus.initialized
								? t("status.ready")
								: t("status.loading")}
						</span>
					</div>
				)}

				{/* EM-LLM Memory */}
				{systemStatus?.em_llm_enabled && (
					<div className="flex items-center justify-between group hover:bg-white/5 rounded-lg p-2 -m-2 transition-all duration-200">
						<div className="flex items-center gap-2.5">
							<div className="w-7 h-7 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
								<Database className="w-3.5 h-3.5" />
							</div>
							<span className="text-[11px] text-gray-400 font-medium">
								EM-LLM
							</span>
						</div>
						<span className="text-[11px] font-bold text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">
							{systemStatus.memory_events} {t("status.events")}
						</span>
					</div>
				)}

				{/* Message Count */}
				{systemStatus && (
					<div className="flex items-center justify-between group hover:bg-white/5 rounded-lg p-2 -m-2 transition-all duration-200">
						<div className="flex items-center gap-2.5">
							<div className="w-7 h-7 rounded-lg bg-gold-500/10 text-gold-400 flex items-center justify-center">
								<MessageSquare className="w-3.5 h-3.5" />
							</div>
							<span className="text-[11px] text-gray-400 font-medium">
								{t("status.messages")}
							</span>
						</div>
						<span className="text-[11px] font-bold text-gold-400 bg-gold-500/10 px-2 py-0.5 rounded">
							{systemStatus.total_messages}
						</span>
					</div>
				)}
			</div>

			{/* Footer - Memory Stats Detail */}
			{memoryStats && totalMemoryEvents > 0 && (
				<div className="mt-4 pt-3 border-t border-white/5">
					<div className="grid grid-cols-2 gap-2 text-[10px]">
						{memoryStats.char_memory && (
							<div className="text-center p-1.5 rounded bg-white/5">
								<div className="text-gray-500 uppercase tracking-wider mb-0.5">
									{t("status.char")}
								</div>
								<div className="text-blue-400 font-bold">
									{memoryStats.char_memory.total_events}
								</div>
							</div>
						)}
						{memoryStats.prof_memory && (
							<div className="text-center p-1.5 rounded bg-white/5">
								<div className="text-gray-500 uppercase tracking-wider mb-0.5">
									{t("status.prof")}
								</div>
								<div className="text-purple-400 font-bold">
									{memoryStats.prof_memory.total_events}
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
};

export default SystemStatusPanel;
