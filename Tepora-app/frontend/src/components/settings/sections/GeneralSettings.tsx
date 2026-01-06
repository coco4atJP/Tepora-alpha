import { Settings } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../SettingsComponents";

interface GeneralSettingsProps {
	config: any;
	onChange: any; // Using any to avoid strict type mismatch with specific union types
	toolsConfig: any;
	onUpdateTools: any;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = () => {
	const { t } = useTranslation();
	return (
		<SettingsSection
			title={t("settings.sections.general.label")}
			icon={<Settings size={18} />}
			description={t("settings.sections.general.description")}
		>
			<div className="p-4 rounded-lg bg-white/5 border border-white/10 text-center text-gray-400">
				General Settings - Coming Soon
			</div>
		</SettingsSection>
	);
};

export default GeneralSettings;
