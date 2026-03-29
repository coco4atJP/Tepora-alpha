import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";

interface SearchAgentSettingsProps {
	activeTab?: string;
}

export const SearchAgentSettings: React.FC<SearchAgentSettingsProps> = () => {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col gap-8">
			<SettingsSectionGroup title={t("v2.settings.searchAgent", "Search Agent")}>
				<div className="mb-6 rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
					{t("v2.settings.searchAgentDesc", "The Search / RAG Agent is responsible for executing search queries, synthesizing evidence, and formulating final answers in Search Mode.")}
				</div>
				
				<SettingsRow
					label={t("v2.settings.searchSynthesis", "Synthesis Configuration")}
					description={t("v2.settings.searchSynthesisDesc", "Behavior settings during RAG evidence summarization.")}
				>
					<div className="text-sm text-text-muted">
						Coming Soon
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
