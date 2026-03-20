import React from "react";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SelectionDot } from "../../../../shared/ui/SelectionDot";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";

const URL_POLICY_OPTIONS = [
	{ label: "Strict", value: "strict" },
	{ label: "Balanced", value: "balanced" },
	{ label: "Permissive", value: "permissive" },
];

function parseList(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

interface PrivacySettingsProps {
	activeTab?: string;
}

export const PrivacySettings: React.FC<PrivacySettingsProps> = ({
	activeTab = "Privacy",
}) => {
	const editor = useSettingsEditor();
	const allowWebSearch = editor.readBoolean("privacy.allow_web_search", false);
	const isolationMode = editor.readBoolean("privacy.isolation_mode", false);
	const urlPolicyPreset = editor.readString(
		"privacy.url_policy_preset",
		"balanced",
	);
	const urlDenylist = editor.readStringList("privacy.url_denylist", []).join(", ");
	const quarantineEnabled = editor.readBoolean("quarantine.enabled", false);
	const quarantineRequired = editor.readBoolean("quarantine.required", false);
	const requiredTransports = editor
		.readStringList("quarantine.required_transports", [])
		.join(", ");

	if (activeTab === "Permissions") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Permissions">
					<SettingsRow
						label="Default Approval TTL"
						description="Seconds to retain temporary approvals."
					>
						<div className="w-full max-w-xs">
							<TextField
								type="number"
								value={editor.readNumber("permissions.default_ttl_seconds", 86400)}
								onChange={(event) =>
									editor.updateField(
										"permissions.default_ttl_seconds",
										Number(event.target.value) || 0,
									)
								}
								min={60}
							/>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	return activeTab === "Quarantine" ? (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Quarantine">
				<SettingsRow
					label="MCP Quarantine"
					description="Enable quarantine checks for risky MCP transports"
				>
					<MinToggle
						checked={quarantineEnabled}
						onChange={(checked) =>
							editor.updateField("quarantine.enabled", checked)
						}
						label={quarantineEnabled ? "Enabled" : "Disabled"}
					/>
				</SettingsRow>
				<SettingsRow
					label="Quarantine Required"
					description="Reject execution if the transport cannot satisfy quarantine rules"
				>
					<MinToggle
						checked={quarantineRequired}
						onChange={(checked) =>
							editor.updateField("quarantine.required", checked)
						}
						label={quarantineRequired ? "Required" : "Optional"}
					/>
				</SettingsRow>
				<SettingsRow
					label="Required Transports"
					description="Comma-separated transport names that must satisfy quarantine"
				>
					<div className="w-full max-w-xl">
						<TextField
							value={requiredTransports}
							onChange={(event) =>
								editor.updateField(
									"quarantine.required_transports",
									parseList(event.target.value),
								)
							}
							placeholder="stdio, wasm"
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	) : (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Privacy">
				<SettingsRow
					label="Web Search Allowed"
					description="Permit backend-driven web access for search and fetch tools"
				>
					<MinToggle
						checked={allowWebSearch}
						onChange={(checked) =>
							editor.updateField("privacy.allow_web_search", checked)
						}
						label={allowWebSearch ? "Allowed" : "Blocked"}
					/>
				</SettingsRow>
				<SettingsRow
					label="Isolation Mode"
					description="Hard-disable web access and stricter external integrations"
				>
					<MinToggle
						checked={isolationMode}
						onChange={(checked) => {
							editor.updateField("privacy.isolation_mode", checked);
							if (checked) {
								editor.updateField("privacy.allow_web_search", false);
							}
						}}
						label={isolationMode ? "Strict" : "Off"}
					/>
				</SettingsRow>
				<SettingsRow
					label="URL Policy"
					description="Preset for web access behavior and fetch strictness"
				>
					{URL_POLICY_OPTIONS.map((option) => (
						<SelectionDot
							key={option.value}
							label={option.label}
							selected={urlPolicyPreset === option.value}
							onClick={() =>
								editor.updateField("privacy.url_policy_preset", option.value)
							}
						/>
					))}
				</SettingsRow>
				<SettingsRow
					label="URL Denylist"
					description="Comma-separated domains or patterns blocked from web fetch"
				>
					<div className="w-full max-w-2xl">
						<TextField
							value={urlDenylist}
							onChange={(event) =>
								editor.updateField(
									"privacy.url_denylist",
									parseList(event.target.value),
								)
							}
							placeholder="e.g. *.example.com, localhost"
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
