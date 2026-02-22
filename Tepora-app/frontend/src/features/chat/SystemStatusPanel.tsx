import { Activity, Cpu, Database, MessageSquare } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSystemStatus } from "../../hooks/useSystemStatus";
import type { MemoryStats } from "../../types";

interface SystemStatusPanelProps {
	isConnected: boolean;
	memoryStats: MemoryStats | null;
}

const SystemStatusPanel: React.FC<SystemStatusPanelProps> = ({ isConnected, memoryStats }) => {
	const { t } = useTranslation();
	const { data: systemStatus } = useSystemStatus();

	const totalMemoryEvents =
		(memoryStats?.char_memory?.total_events || 0) + (memoryStats?.prof_memory?.total_events || 0);

	return (
		<div className="glass-panel p-6 w-full rounded-[2rem] animate-fade-in mt-auto backdrop-blur-2xl border border-white/5 shadow-[0_20px_40px_rgba(0,0,0,0.4)] relative overflow-hidden">
			<div className="absolute inset-0 bg-gradient-to-br from-gold-500/5 to-transparent opacity-50 pointer-events-none" />
			{/* Header */}
			<div className="flex items-center gap-3 mb-5 pb-4 border-b border-white/10 relative z-10">
				<Activity className="w-4 h-4 text-gold-400 animate-pulse" />
				<h3 className="text-gold-200 text-[10px] font-bold uppercase tracking-[0.3em] flex-1 font-display opacity-90">
					{t("status.title")}
				</h3>
				<div
					className={`w-2 h-2 rounded-full shadow-[0_0_8px_rgba(current-color,0.5)] ml-2 ${isConnected ? "bg-green-400 animate-pulse shadow-green-400/50" : "bg-red-400 shadow-red-400/50"}`}
				/>
			</div>

			{/* Status Items */}
			<div className="space-y-3">
				{/* Network Status */}
				<div className="flex items-center justify-between group hover:bg-white/10 rounded-xl p-2.5 -m-2.5 transition-all duration-300 relative z-10">
					<div className="flex items-center gap-3">
						<div
							className={`w-8 h-8 rounded-xl flex items-center justify-center shadow-inner ${isConnected ? "bg-green-500/15 text-green-400 border border-green-500/20" : "bg-red-500/15 text-red-400 border border-red-500/20"
								}`}
						>
							<Cpu className="w-4 h-4" />
						</div>
						<span className="text-[10px] text-gray-400 font-medium tracking-wider uppercase">{t("status.network")}</span>
					</div>
					<span
						className={`text-[10px] uppercase tracking-widest font-bold px-2.5 py-1 rounded-full ${isConnected ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"
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
								className={`w-7 h-7 rounded-lg flex items-center justify-center ${systemStatus.initialized
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
							className={`text-[11px] font-semibold px-2 py-0.5 rounded ${systemStatus.initialized
								? "text-blue-400 bg-blue-500/10"
								: "text-gray-400 bg-gray-500/10"
								}`}
						>
							{systemStatus.initialized ? t("status.ready") : t("status.loading")}
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
							<span className="text-[11px] text-gray-400 font-medium">EM-LLM</span>
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
							<span className="text-[11px] text-gray-400 font-medium">{t("status.messages")}</span>
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
