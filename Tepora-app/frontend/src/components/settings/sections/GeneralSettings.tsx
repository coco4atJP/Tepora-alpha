import { Settings } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { Config } from "../../../context/SettingsContext";
import { FormGroup, FormInput, SettingsSection } from "../SettingsComponents";

interface GeneralSettingsProps {
	config: Config["app"];
	onChange: <K extends keyof Config["app"]>(
		field: K,
		value: Config["app"][K],
	) => void;
	toolsConfig: Config["tools"];
	onUpdateTools: <K extends keyof Config["tools"]>(
		field: K,
		value: Config["tools"][K],
	) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({
	config,
	onChange,
	toolsConfig,
	onUpdateTools,
}) => {
	const { t } = useTranslation();

	return (
		<SettingsSection
			title={t("settings.sections.general.label")}
			icon={<Settings size={18} />}
			description={t("settings.sections.general.description")}
		>
			<div className="space-y-6">
				{/* Google Search Configuration */}
				<div className="space-y-4">
					<h3 className="text-lg font-medium text-white">Google検索設定</h3>
					<FormGroup
						label="Google Search API Key"
						description="Google Custom Search JSON APIを利用するためのAPIキーを入力してください。"
					>
						<FormInput
							type="password"
							value={toolsConfig.google_search_api_key || ""}
							onChange={(value) =>
								onUpdateTools("google_search_api_key", value as string)
							}
							placeholder="AIza..."
						/>
					</FormGroup>

					<FormGroup
						label="Search Engine ID"
						description="Programmable Search EngineのIDを入力してください。"
					>
						<FormInput
							type="text"
							value={toolsConfig.google_search_engine_id || ""}
							onChange={(value) =>
								onUpdateTools("google_search_engine_id", value as string)
							}
							placeholder="0123456789..."
						/>
					</FormGroup>
				</div>

				<div className="border-t border-white/10 my-4" />

				{/* Other General Settings (App Config) - Partially implemented as placeholders or todo */}
				<div className="space-y-4">
					<h3 className="text-lg font-medium text-white">
						アプリケーション設定
					</h3>
					<FormGroup
						label={t("settings.fields.language.label")}
						description={t("settings.fields.language.description")}
					>
						<FormInput
							value={config.language}
							onChange={(value) => onChange("language", value as string)}
							placeholder="ja"
						/>
					</FormGroup>
				</div>
			</div>
		</SettingsSection>
	);
};

export default GeneralSettings;
