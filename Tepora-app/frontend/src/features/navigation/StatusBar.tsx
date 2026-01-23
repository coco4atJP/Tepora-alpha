import { Database, Wifi, WifiOff } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSystemStatus } from "../../hooks/useSystemStatus";
import type { MemoryStats } from "../../types";

interface StatusBarProps {
	isConnected: boolean;
	memoryStats: MemoryStats | null;
}

const StatusBar: React.FC<StatusBarProps> = ({ isConnected, memoryStats }) => {
	const { t } = useTranslation();
	const { data: systemStatus } = useSystemStatus();

	return (
		<div className="bg-gray-900 border-b border-gray-700 px-4 py-2 flex items-center gap-4 text-sm">
			<div className="flex items-center gap-2">
				{isConnected ? (
					<>
						<Wifi className="w-4 h-4 text-green-500" />
						<span className="text-green-500">
							{t("status.connected", "接続済み")}
						</span>
					</>
				) : (
					<>
						<WifiOff className="w-4 h-4 text-red-500" />
						<span className="text-red-500">
							{t("status.disconnected", "未接続")}
						</span>
					</>
				)}
			</div>

			{systemStatus?.em_llm_enabled && (
				<div className="flex items-center gap-2">
					<Database className="w-4 h-4 text-blue-500" />
					<span className="text-gray-400">
						EM-LLM:{" "}
						<span className="text-blue-400">
							{systemStatus.memory_events} {t("status.events", "イベント")}
						</span>
					</span>
				</div>
			)}

			{memoryStats && (
				<div className="text-gray-500 text-xs">
					{(memoryStats.char_memory?.total_events || 0) +
						(memoryStats.prof_memory?.total_events || 0)}{" "}
					events
				</div>
			)}
		</div>
	);
};

export default StatusBar;
