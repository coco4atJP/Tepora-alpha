import { BrainCircuit, CheckCircle2, Circle, Clock, Loader2 } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { AgentActivity } from "../../types";

interface AgentStatusProps {
	activityLog: AgentActivity[];
}

const AgentStatus: React.FC<AgentStatusProps> = ({ activityLog }) => {
	const { t } = useTranslation();
	// Show only the latest 20 activities to prevent lag
	const recentActivities = [...activityLog].reverse().slice(0, 20);
	const isProcessing = activityLog.length > 0 && activityLog[activityLog.length - 1].status === "processing";

	return (
		<div className="h-full flex flex-col glass-panel p-4 overflow-hidden animate-fade-in transition-all duration-300 border border-tea-500/10">
			{/* Header */}
			<div className="flex items-center gap-2 mb-4 text-tea-400 border-b border-white/10 pb-2">
				<BrainCircuit className={`w-4 h-4 ${isProcessing ? 'animate-neural-pulse' : ''}`} />
				<h3 className="text-xs font-bold uppercase tracking-[0.2em] font-display">
					{t("agent.title")}
				</h3>
				{isProcessing && (
					<div className="ml-auto flex items-end gap-1 h-3 opacity-80" aria-label="Thinking">
						<div className="w-1 bg-tea-400 rounded-full animate-sound-wave" style={{ animationDelay: "0s" }} />
						<div className="w-1 bg-tea-400 rounded-full animate-sound-wave" style={{ animationDelay: "0.2s" }} />
						<div className="w-1 bg-tea-400 rounded-full animate-sound-wave" style={{ animationDelay: "0.4s" }} />
					</div>
				)}
			</div>

			{/* Timeline */}
			<div className="flex-1 overflow-y-auto custom-scrollbar -mr-2 pr-2 relative space-y-4">
				{recentActivities.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full text-gray-600 space-y-2 opacity-50">
						<Clock className="w-8 h-8" />
						<span className="text-xs font-mono uppercase tracking-widest">
							{t("agent.waiting")}
						</span>
					</div>
				) : (
					recentActivities.map((step, index) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: Log history
							key={index}
							className="relative pl-6 group"
						>
							{/* Timeline Line */}
							{index !== recentActivities.length - 1 && (
								<div className="absolute left-[9px] top-6 bottom-[-24px] w-px bg-white/5 group-hover:bg-tea-500/20 transition-colors"></div>
							)}

							{/* Node Indicator */}
							<div
								className={`absolute left-0 top-1.5 w-[18px] h-[18px] rounded-full border flex items-center justify-center bg-black/50 z-10 transition-colors duration-300 ${
									step.status === "completed"
										? "border-semantic-success/50 text-semantic-success shadow-[0_0_10px_rgba(79,255,192,0.2)]"
										: step.status === "processing"
											? "border-tea-500 text-tea-500 shadow-[0_0_10px_rgba(233,122,58,0.3)]"
											: "border-gray-600 text-gray-600"
								}`}
							>
								{step.status === "completed" && (
									<CheckCircle2 className="w-3 h-3 text-semantic-success" />
								)}
								{step.status === "processing" && <Loader2 className="w-3 h-3 animate-spin" />}
								{step.status === "pending" && <Circle className="w-3 h-3" />}
							</div>

							{/* Content Card */}
							<div
								className={`p-3 rounded-lg border backdrop-blur-sm transition-all duration-300 ${
									step.status === "processing"
										? "bg-tea-900/10 border-tea-500/30 shadow-[0_0_15px_rgba(0,0,0,0.3)] glow-border"
										: "bg-black/20 border-white/5 hover:bg-white/5"
								}`}
							>
								<div className="flex justify-between items-start gap-2 mb-1">
									<span
										className={`text-[10px] font-bold uppercase tracking-wider ${
											step.agent_name.includes("Supervisor")
												? "text-amber-400"
												: step.agent_name.includes("Planner")
													? "text-purple-400"
													: step.agent_name.includes("Search")
														? "text-cyan-400"
														: "text-tea-400"
										}`}
									>
										{step.agent_name}
									</span>
									<span className="text-[9px] font-mono text-gray-500">
										{new Date().toLocaleTimeString()}
									</span>
								</div>

								<div
									className={`text-xs leading-relaxed ${
										step.status === "completed" ? "text-gray-400" : "text-gray-200"
									}`}
								>
									<div
										className={`break-words ${step.status === "processing" ? "text-tea-100 font-semibold" : ""}`}
									>
										{step.details}
									</div>
								</div>

								{step.status === "processing" && (
									<div className="mt-3 flex items-center gap-2 h-4 overflow-hidden">
										<div className="flex-1 h-[1px] bg-tea-900/50 rounded relative overflow-hidden">
											<div className="absolute inset-0 bg-gradient-to-r from-transparent via-tea-500 to-transparent w-1/3 animate-[shimmer_1.5s_infinite_linear]" />
										</div>
										<span className="text-[9px] font-mono tracking-widest uppercase opacity-60 text-tea-400 animate-pulse">
											Thinking
										</span>
									</div>
								)}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
};

export default AgentStatus;
