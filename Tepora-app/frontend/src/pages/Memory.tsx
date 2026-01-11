import type React from "react";
import { useEffect } from "react";
import { useWebSocketContext } from "../context/WebSocketContext";

const Memory: React.FC = () => {
	const { memoryStats, requestStats, isConnected } = useWebSocketContext();

	useEffect(() => {
		if (isConnected) {
			requestStats();
			// Poll every 5 seconds
			const interval = setInterval(requestStats, 5000);
			return () => clearInterval(interval);
		}
	}, [isConnected, requestStats]);

	return (
		<div className="p-8 h-full overflow-auto">
			<h1 className="text-3xl font-bold mb-6 text-white">Memory Statistics</h1>

			{!isConnected && (
				<div className="bg-yellow-500/10 border border-yellow-500 text-yellow-500 p-4 rounded mb-6">
					Connecting to memory system...
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				{/* Character Memory */}
				<div className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
					<h2 className="text-xl font-bold text-blue-400 mb-4 border-b border-gray-700 pb-2">
						Character Memory (EM-LLM)
					</h2>
					{memoryStats?.char_memory ? (
						<div className="space-y-4">
							<StatItem
								label="Total Events"
								value={memoryStats.char_memory.total_events}
							/>
							<StatItem
								label="Total Tokens"
								value={memoryStats.char_memory.total_tokens_in_memory}
							/>
							<StatItem
								label="Mean Event Size"
								value={
									memoryStats.char_memory.mean_event_size?.toFixed(1) || "0.0"
								}
							/>
							{memoryStats.char_memory.surprise_statistics && (
								<>
									<div className="mt-4 pt-4 border-t border-gray-700">
										<p className="text-sm text-gray-400 mb-2">
											Surprise Statistics
										</p>
									</div>
									<StatItem
										label="Mean Surprise"
										value={
											memoryStats.char_memory.surprise_statistics.mean?.toFixed(
												3,
											) || "N/A"
										}
									/>
									<StatItem
										label="Max Surprise"
										value={
											memoryStats.char_memory.surprise_statistics.max?.toFixed(
												3,
											) || "N/A"
										}
									/>
								</>
							)}
						</div>
					) : (
						<p className="text-gray-500 italic">No data available</p>
					)}
				</div>

				{/* Professional Memory */}
				<div className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
					<h2 className="text-xl font-bold text-green-400 mb-4 border-b border-gray-700 pb-2">
						Professional Memory (EM-LLM)
					</h2>
					{memoryStats?.prof_memory ? (
						<div className="space-y-4">
							<StatItem
								label="Total Events"
								value={memoryStats.prof_memory.total_events}
							/>
							<StatItem
								label="Total Tokens"
								value={memoryStats.prof_memory.total_tokens_in_memory}
							/>
							<StatItem
								label="Mean Event Size"
								value={
									memoryStats.prof_memory.mean_event_size?.toFixed(1) || "0.0"
								}
							/>
							{memoryStats.prof_memory.surprise_statistics && (
								<>
									<div className="mt-4 pt-4 border-t border-gray-700">
										<p className="text-sm text-gray-400 mb-2">
											Surprise Statistics
										</p>
									</div>
									<StatItem
										label="Mean Surprise"
										value={
											memoryStats.prof_memory.surprise_statistics.mean?.toFixed(
												3,
											) || "N/A"
										}
									/>
									<StatItem
										label="Max Surprise"
										value={
											memoryStats.prof_memory.surprise_statistics.max?.toFixed(
												3,
											) || "N/A"
										}
									/>
								</>
							)}
						</div>
					) : (
						<p className="text-gray-500 italic">No data available</p>
					)}
				</div>
			</div>
		</div>
	);
};

const StatItem: React.FC<{ label: string; value: number | string }> = ({
	label,
	value,
}) => (
	<div className="flex justify-between items-center border-b border-gray-700/50 pb-2 last:border-0">
		<span className="text-gray-400">{label}</span>
		<span className="text-white font-mono font-bold">{value}</span>
	</div>
);

export default Memory;
