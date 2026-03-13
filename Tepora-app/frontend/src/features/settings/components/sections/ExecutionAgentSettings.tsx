import { Bot, Cpu, ShieldCheck, Tags, Wrench } from "lucide-react";
import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionAgentConfig } from "../../../../types";
import { SettingsSection } from "../SettingsComponents";

interface ExecutionAgentSettingsProps {
	agents: Record<string, ExecutionAgentConfig>;
}

const ExecutionAgentSettings: React.FC<ExecutionAgentSettingsProps> = ({ agents }) => {
	const { t } = useTranslation();
	const entries = useMemo(
		() =>
			Object.values(agents).sort((a, b) => {
				if (a.priority !== b.priority) return a.priority - b.priority;
				return a.name.localeCompare(b.name);
			}),
		[agents],
	);

	return (
		<SettingsSection
			title={t("settings.sections.execution_agents.title", "Execution Agents")}
			icon={<Bot size={18} />}
			description={t(
				"settings.sections.execution_agents.description",
				"Browse the available execution agents. Controller routing uses the summary, while execution uses the packaged skill.",
			)}
		>
			<div className="space-y-4">
				<div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs leading-6 text-gray-300">
					{t(
						"settings.sections.execution_agents.read_only_notice",
						"Execution agents are now package-based and read-only from the GUI. Add or override them from the execution_agents package directories.",
					)}
				</div>

				{entries.length === 0 ? (
					<div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-sm text-gray-400">
						{t("settings.sections.execution_agents.empty", "No execution agents are available.")}
					</div>
				) : (
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						{entries.map((agent) => {
							const allowedToolCount = agent.tool_policy.allow_all
								? t("settings.sections.execution_agents.tool_policy_all", "All allowed")
								: `${agent.tool_policy.allowed_tools.length} ${t("settings.sections.execution_agents.tool_policy_count", "allowed")}`;
							return (
								<div
									key={agent.id}
									className={`rounded-2xl border px-5 py-4 transition-colors ${
										agent.enabled ? "border-white/10 bg-white/[0.03]" : "border-white/5 bg-black/20 opacity-65"
									}`}
								>
									<div className="mb-4 flex items-start justify-between gap-3">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-3">
												<div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-black/30 text-xl">
													{agent.icon || "🤖"}
												</div>
												<div className="min-w-0">
													<div className="truncate text-base font-semibold text-white">{agent.name}</div>
													<div className="truncate font-mono text-xs text-gray-500">@{agent.id}</div>
												</div>
											</div>
										</div>
										<span
											className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${
												agent.enabled ? "bg-emerald-500/10 text-emerald-300" : "bg-white/5 text-gray-500"
											}`}
										>
											{agent.enabled ? t("common.active", "Active") : t("common.disabled", "Disabled")}
										</span>
									</div>

									{agent.description && <p className="mb-3 text-sm leading-6 text-gray-300">{agent.description}</p>}
									{agent.controller_summary && (
										<div className="mb-4 rounded-xl border border-tea-400/10 bg-tea-400/5 px-4 py-3 text-sm leading-6 text-tea-100/90">
											<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-tea-300/80">
												{t("settings.sections.execution_agents.controller_summary", "Controller Summary")}
											</div>
											{agent.controller_summary}
										</div>
									)}

									<div className="grid grid-cols-1 gap-2 text-xs text-gray-400 sm:grid-cols-2">
										<div className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/20 px-3 py-2">
											<Cpu size={14} className="text-gold-300" />
											<span>{agent.model_config_name || t("settings.sections.execution_agents.model_default", "Global default model")}</span>
										</div>
										<div className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/20 px-3 py-2">
											<Wrench size={14} className="text-gold-300" />
											<span>{allowedToolCount}</span>
										</div>
										<div className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/20 px-3 py-2">
											<ShieldCheck size={14} className="text-gold-300" />
											<span>
												{agent.tool_policy.require_confirmation.length > 0
													? `${agent.tool_policy.require_confirmation.length} ${t("settings.sections.execution_agents.confirmation_count", "require confirmation")}`
													: t("settings.sections.execution_agents.confirmation_default", "Default confirmation policy")}
											</span>
										</div>
										<div className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/20 px-3 py-2">
											<Tags size={14} className="text-gold-300" />
											<span>
												{agent.tags.length > 0 ? agent.tags.join(", ") : t("settings.sections.execution_agents.tags_empty", "No tags")}
											</span>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</SettingsSection>
	);
};

export default ExecutionAgentSettings;
