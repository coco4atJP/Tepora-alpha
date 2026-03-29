import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";

interface SupervisorAgentSettingsProps {
	activeTab?: string;
}

export const SupervisorAgentSettings: React.FC<SupervisorAgentSettingsProps> = () => {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col gap-8">
			<SettingsSectionGroup title={t("v2.settings.supervisorAgent", "Supervisor Agent")}>
				<div className="mb-6 rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
					{t("v2.settings.supervisorDesc", "The Supervisor Agent orchestrates the execution flow. It receives user requests and decides whether to route them to a Planner, execute them immediately via Executive Agents, or handle them via Search or Chat.")}
				</div>
				
				{/* プレースホルダー的設定項目。AdvancedSettings等から移管されるかもしれない */}
				<SettingsRow
					label={t("v2.settings.agentModelLink", "Supervisor Model")}
					description={t("v2.settings.agentModelLinkDesc", "Model to use for routing logic.")}
				>
					<div className="text-sm text-text-muted">
						{/* TODO: Add model selection dropdown */}
						Coming Soon
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
