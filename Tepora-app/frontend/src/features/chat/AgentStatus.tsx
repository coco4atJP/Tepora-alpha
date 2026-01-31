import {
	BrainCircuit,
	CheckCircle2,
	Circle,
	Clock,
	Loader2,
} from "lucide-react";
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

	return (
		<div className="h-full flex flex-col glass-panel p-4 overflow-hidden animate-fade-in transition-all duration-300 border border-tea-500/10">
			{/* Header */}
			<div className="flex items-center gap-2 mb-4 text-tea-400 border-b border-white/10 pb-2">
				<BrainCircuit className="w-4 h-4" />
				<h3 className="text-xs font-bold uppercase tracking-[0.2em] font-display">
					{t("agent.title")}
				</h3>
				{activityLog.length > 0 &&
					activityLog[activityLog.length - 1].status === "processing" && (
						<span className="ml-auto flex h-2 w-2 relative">
							<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-tea-400 opacity-75"></span>
							<span className="relative inline-flex rounded-full h-2 w-2 bg-tea-500"></span>
						</span>
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
							key={`${step.step}-${step.agent_name}`}
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
										? "border-green-500/50 text-green-500 shadow-[0_0_10px_rgba(34,197,94,0.2)]"
										: step.status === "processing"
											? "border-tea-500 text-tea-500 shadow-[0_0_10px_rgba(233,122,58,0.3)]"
											: "border-gray-600 text-gray-600"
								}`}
							>
								{step.status === "completed" && (
									<CheckCircle2 className="w-3 h-3" />
								)}
								{step.status === "processing" && (
									<Loader2 className="w-3 h-3 animate-spin" />
								)}
								{step.status === "pending" && <Circle className="w-3 h-3" />}
							</div>

							{/* Content Card */}
							<div
								className={`p-3 rounded-lg border backdrop-blur-sm transition-all duration-300 ${
									step.status === "processing"
										? "bg-tea-900/10 border-tea-500/30 shadow-[0_0_15px_rgba(0,0,0,0.3)]"
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
										step.status === "completed"
											? "text-gray-400"
											: "text-gray-200"
									}`}
								>
									<div
										className={`break-words ${step.status === "processing" ? "text-tea-100 font-semibold" : ""}`}
									>
										{step.details}
									</div>
								</div>

								{step.status === "processing" && (
									<div className="flex gap-3 items-center text-tea-500/50 animate-pulse px-2 mt-2">
										<span className="h-1 w-1 bg-current rounded-full"></span>
										<span className="h-1 w-1 bg-current rounded-full animation-delay-200"></span>
										<span className="h-1 w-1 bg-current rounded-full animation-delay-400"></span>
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
