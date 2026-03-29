import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { readNestedValue, useSettingsEditor } from "../../model/editor";
import { AgentSkillsManagementPanel } from "../components/AgentSkillsManagementPanel";

interface ExecutiveAgentsSettingsProps {
	activeTab?: string;
}

export const ExecutiveAgentsSettings: React.FC<ExecutiveAgentsSettingsProps> = () => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();

	const customAgentsValue = editor.draft
		? readNestedValue(editor.draft, "custom_agents")
		: undefined;
	const customAgents =
		customAgentsValue &&
		typeof customAgentsValue === "object" &&
		!Array.isArray(customAgentsValue)
			? Object.entries(customAgentsValue as Record<string, Record<string, unknown>>).map(
					([id, value]) => ({
						id,
						name: String(value.name ?? id),
						description: String(value.description ?? ""),
						enabled: value.enabled !== false,
						tags: Array.isArray(value.tags)
							? value.tags.map((tag) => String(tag))
							: [],
					}),
			  )
			: [];

	return (
		<div className="flex flex-col gap-12">
			{/* Definitions part */}
			<SettingsSectionGroup title={t("v2.settings.customAgentsTitle", "Executive Agents Definitions")}>
				<div className="mb-4 text-sm text-text-muted">
					{t("v2.settings.customAgentsDescription", "These are the underlying agent definitions that execute tasks when called by the supervisor.")}
				</div>
				<div className="grid gap-4 md:grid-cols-2">
					{customAgents.length > 0 ? (
						customAgents.map((agent) => (
							<div
								key={agent.id}
								className="rounded-[24px] border border-primary/10 bg-white/55 p-5"
							>
								<div className="flex items-center justify-between gap-3">
									<div className="text-base font-medium text-text-main">
										{agent.name}
									</div>
									<div className="rounded-full border border-primary/15 px-2.5 py-0.5 text-[0.68rem] uppercase tracking-[0.16em] text-primary/80">
										{agent.enabled
											? t("v2.common.enabled", "Enabled")
											: t("v2.common.disabled", "Disabled")}
									</div>
								</div>
								<div className="mt-3 text-sm leading-7 text-text-muted">
									{agent.description || t("v2.character.noDescription", "No description")}
								</div>
								<div className="mt-4 text-xs uppercase tracking-[0.16em] text-text-muted">
									{agent.tags.length > 0 ? agent.tags.join(", ") : t("v2.settings.noTags", "No tags")}
								</div>
							</div>
						))
					) : (
						<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
							{t("v2.settings.noCustomAgents", "No executive agents are configured yet. (Add them in config.json)")}
						</div>
					)}
				</div>
			</SettingsSectionGroup>

			{/* Skills part */}
			<div className="border-t border-primary/10 pt-8">
				<SettingsSectionGroup title={t("v2.settings.agentSkillsTitle", "Executive Agent Skills (Capabilities)")}>
					<div className="mb-4 text-sm text-text-muted">
						{t("v2.settings.agentSkillsDescription", "Skills define the instructions, tool policies, and behaviors that an Executive Agent is equipped with.")}
					</div>
					<AgentSkillsManagementPanel />
				</SettingsSectionGroup>
			</div>
		</div>
	);
};
