import { Cpu } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../SettingsComponents";

interface ModelSettingsProps {
	llmConfig: any;
	modelsConfig: any;
	onUpdateLlm: any; // Using any to avoid strict type mismatch
	onUpdateModel: any;
}

const ModelSettings: React.FC<ModelSettingsProps> = () => {
	const { t } = useTranslation();
	return (
		<SettingsSection
			title={t("settings.sections.models.label")}
			icon={<Cpu size={18} />}
			description={t("settings.sections.models.description")}
		>
			<div className="p-4 rounded-lg bg-white/5 border border-white/10 text-center text-gray-400">
				Model Settings - Coming Soon
			</div>
		</SettingsSection>
	);
};

export default ModelSettings;
