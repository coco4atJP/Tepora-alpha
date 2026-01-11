import { AlertTriangle, Eye, Shield } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { Config } from "../../../context/SettingsContext";
import { FormGroup, FormSwitch, SettingsSection } from "../SettingsComponents";

interface PrivacySettingsProps {
	privacyConfig: Config["privacy"];
	onUpdate: <K extends keyof Config["privacy"]>(
		field: K,
		value: Config["privacy"][K],
	) => void;
}

/**
 * Privacy Settings Section.
 * Controls for web search consent and data privacy options.
 */
const PrivacySettings: React.FC<PrivacySettingsProps> = ({
	privacyConfig,
	onUpdate,
}) => {
	const { t } = useTranslation();

	return (
		<SettingsSection
			title={t("settings.sections.privacy.title")}
			icon={<Shield size={18} />}
			description={t("settings.sections.privacy.description")}
		>
			<div className="space-y-6">
				{/* Web Search Consent */}
				<div className="space-y-4">
					<FormGroup
						label={t("settings.privacy.web_search.label")}
						description={t("settings.privacy.web_search.description")}
					>
						<FormSwitch
							checked={privacyConfig?.allow_web_search ?? false}
							onChange={(value) => onUpdate("allow_web_search", value)}
						/>
					</FormGroup>

					{/* Data Sharing Explanation Panel */}
					{privacyConfig?.allow_web_search && (
						<div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
							<div className="flex items-start gap-3">
								<AlertTriangle
									className="text-yellow-400 shrink-0 mt-0.5"
									size={20}
								/>
								<div>
									<h4 className="font-medium text-yellow-300 mb-2">
										{t("settings.privacy.web_search.warning_title")}
									</h4>
									<ul className="text-sm text-yellow-200/80 space-y-1">
										<li className="flex items-start gap-2">
											<span className="text-yellow-400">•</span>
											{t("settings.privacy.web_search.warning_query")}
										</li>
										<li className="flex items-start gap-2">
											<span className="text-yellow-400">•</span>
											{t("settings.privacy.web_search.warning_api")}
										</li>
									</ul>
								</div>
							</div>
						</div>
					)}
				</div>

				<div className="border-t border-white/10 my-4" />

				{/* PII Redaction */}
				<FormGroup
					label={t("settings.privacy.redact_pii.label")}
					description={t("settings.privacy.redact_pii.description")}
				>
					<div className="flex items-center gap-3">
						<Eye className="text-gray-400" size={18} />
						<FormSwitch
							checked={privacyConfig?.redact_pii ?? true}
							onChange={(value) => onUpdate("redact_pii", value)}
						/>
					</div>
				</FormGroup>
			</div>
		</SettingsSection>
	);
};

export default PrivacySettings;
