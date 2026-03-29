import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";

interface PlannerAgentSettingsProps {
	activeTab?: string;
}

export const PlannerAgentSettings: React.FC<PlannerAgentSettingsProps> = () => {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col gap-8">
			<SettingsSectionGroup title={t("v2.settings.plannerAgent", "Planner Agent")}>
				<div className="mb-6 rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
					{t("v2.settings.plannerDesc", "The Planner Agent breaks down complex tasks into sub-tasks (plans) for the Executive Agents to follow.")}
				</div>
				
				<SettingsRow
					label={t("v2.settings.plannerThinking", "Planner Thinking Configuration")}
					description={t("v2.settings.plannerThinkingDesc", "Configure reasoning efforts when generating plans.")}
				>
					<div className="text-sm text-text-muted">
						Coming Soon
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
