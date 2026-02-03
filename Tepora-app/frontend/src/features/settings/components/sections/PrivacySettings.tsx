import { AlertTriangle, Eye, Loader2, Shield } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { Config } from "../../../../context/SettingsContext";
import { useMcpPolicy } from "../../../../hooks/useMcp";
import { useSettings } from "../../../../hooks/useSettings";
import { FormGroup, FormSwitch, SettingsSection } from "../SettingsComponents";

interface PrivacySettingsProps {
	privacyConfig: Config["privacy"];
	onUpdate: <K extends keyof Config["privacy"]>(field: K, value: Config["privacy"][K]) => void;
}

// Sub-component for Tool Security Policy
const ToolSecurityPolicy: React.FC = () => {
	const { t } = useTranslation();
	const { policy, loading, saving, updatePolicy } = useMcpPolicy();

	return (
		<div className="space-y-4">
			<h3 className="text-lg font-medium text-white flex items-center gap-2">
				{t("settings.mcp.policy.title")}
			</h3>

			{loading ? (
				<div className="flex justify-center p-4">
					<Loader2 className="animate-spin text-gray-400" size={24} />
				</div>
			) : (
				<div className="space-y-4">
					<FormGroup
						label={t("settings.mcp.policy.mode.label")}
						description={t("settings.mcp.policy.mode.description")}
					>
						<select
							value={policy?.policy || "local_only"}
							onChange={(e) => updatePolicy({ policy: e.target.value })}
							disabled={saving}
							className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
						>
							<option value="local_only">{t("settings.mcp.policy.mode.local_only")}</option>
							<option value="stdio_only">{t("settings.mcp.policy.mode.stdio_only")}</option>
							<option value="allowlist">{t("settings.mcp.policy.mode.allowlist")}</option>
						</select>
					</FormGroup>

					<FormGroup
						label={t("settings.mcp.policy.confirmation.label")}
						description={t("settings.mcp.policy.confirmation.description")}
					>
						<FormSwitch
							checked={policy?.require_tool_confirmation ?? true}
							onChange={(val: boolean) => updatePolicy({ require_tool_confirmation: val })}
						/>
					</FormGroup>
				</div>
			)}
		</div>
	);
};

/**
 * Privacy Settings Section.
 * Controls for web search consent and data privacy options.
 */
const PrivacySettings: React.FC<PrivacySettingsProps> = ({ privacyConfig, onUpdate }) => {
	const { t } = useTranslation();
	const { config } = useSettings();

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
						orientation="horizontal"
						className="delay-0"
					>
						<FormSwitch
							checked={privacyConfig?.allow_web_search ?? false}
							onChange={(value) => onUpdate("allow_web_search", value)}
						/>
					</FormGroup>

					{/* Data Sharing Explanation Panel */}
					{config?.privacy?.allow_web_search && (
						<div className="delay-100 settings-form-group bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
							<div className="flex items-start gap-3">
								<AlertTriangle className="text-yellow-400 shrink-0 mt-0.5" size={20} />
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

				{/* Tool Security Policy */}
				<ToolSecurityPolicy />

				<div className="border-t border-white/10 my-4" />

				{/* PII Redaction */}
				<FormGroup
					label={t("settings.privacy.redact_pii.label")}
					description={t("settings.privacy.redact_pii.description")}
					orientation="horizontal"
					className="delay-200"
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
