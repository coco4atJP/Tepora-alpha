import React from "react";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { Select } from "../../../../shared/ui/Select";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";

function parseLineList(value: string): string[] {
	return value
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
}

interface AdvancedSettingsProps {
	activeTab?: string;
}

export const AdvancedSettings: React.FC<AdvancedSettingsProps> = ({
	activeTab = "Execution",
}) => {
	const editor = useSettingsEditor();

	if (activeTab === "Features") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Features">
					<SettingsRow
						label="Transport Mode"
						description="Preferred runtime transport for the v2 client"
					>
						<div className="w-full max-w-sm">
							<Select
								value={editor.readString(
									"features.redesign.transport_mode",
									"websocket",
								)}
								onChange={(event) =>
									editor.updateField(
										"features.redesign.transport_mode",
										event.target.value,
									)
								}
							>
								<option value="ipc">IPC</option>
								<option value="websocket">WebSocket</option>
							</Select>
						</div>
					</SettingsRow>
					<SettingsRow
						label="Frontend Logging"
						description="Send verbose v2 client logs to the backend endpoint"
					>
						<MinToggle
							checked={editor.readBoolean(
								"features.redesign.frontend_logging",
								false,
							)}
							onChange={(checked) =>
								editor.updateField(
									"features.redesign.frontend_logging",
									checked,
								)
							}
							label={
								editor.readBoolean("features.redesign.frontend_logging", false)
									? "Enabled"
									: "Disabled"
							}
						/>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "Agent") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Agent">
					<SettingsRow
						label="Attachment Limit"
						description="Maximum attachments included in a single agent run."
					>
						<NumberField
							value={editor.readNumber("agent.max_attachments", 5)}
							onChange={(value) => editor.updateField("agent.max_attachments", value)}
						/>
					</SettingsRow>
					<SettingsRow
						label="Attachment Preview"
						description="Preview characters shown to executors from attachments."
					>
						<NumberField
							value={editor.readNumber("agent.attachment_preview_chars", 500)}
							onChange={(value) =>
								editor.updateField("agent.attachment_preview_chars", value)
							}
						/>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "Model DL" || activeTab === "Server") {
		const requireAllowlist = editor.readBoolean(
			"model_download.require_allowlist",
			true,
		);
		const warnOnUnlisted = editor.readBoolean(
			"model_download.warn_on_unlisted",
			true,
		);
		const requireRevision = editor.readBoolean(
			"model_download.require_revision",
			true,
		);
		const requireSha256 = editor.readBoolean(
			"model_download.require_sha256",
			true,
		);
		const allowRepoOwners = editor.readStringList(
			"model_download.allow_repo_owners",
			[],
		);
		const serverHost = editor.readString("server.host", "");
		const allowedOrigins = editor.readStringList("server.allowed_origins", []);
		const corsAllowedOrigins = editor.readStringList(
			"server.cors_allowed_origins",
			[],
		);
		const wsAllowedOrigins = editor.readStringList(
			"server.ws_allowed_origins",
			[],
		);

		if (activeTab === "Model DL") {
			return (
				<div className="flex flex-col">
					<SettingsSectionGroup title="Model DL">
						<SettingsRow
							label="Require Allowlist"
							description="Only permit downloads from listed repository owners."
						>
							<MinToggle
								checked={requireAllowlist}
								onChange={(checked) =>
									editor.updateField(
										"model_download.require_allowlist",
										checked,
									)
								}
								label={requireAllowlist ? "Required" : "Optional"}
							/>
						</SettingsRow>
						<SettingsRow
							label="Warn on Unlisted"
							description="Request confirmation when the repository owner is not allowlisted."
						>
							<MinToggle
								checked={warnOnUnlisted}
								onChange={(checked) =>
									editor.updateField(
										"model_download.warn_on_unlisted",
										checked,
									)
								}
								label={warnOnUnlisted ? "Enabled" : "Disabled"}
							/>
						</SettingsRow>
						<SettingsRow
							label="Require Revision"
							description="Require a pinned revision before a download can start."
						>
							<MinToggle
								checked={requireRevision}
								onChange={(checked) =>
									editor.updateField(
										"model_download.require_revision",
										checked,
									)
								}
								label={requireRevision ? "Required" : "Optional"}
							/>
						</SettingsRow>
						<SettingsRow
							label="Require SHA256"
							description="Require expected SHA256 for model downloads."
						>
							<MinToggle
								checked={requireSha256}
								onChange={(checked) =>
									editor.updateField(
										"model_download.require_sha256",
										checked,
									)
								}
								label={requireSha256 ? "Required" : "Optional"}
							/>
						</SettingsRow>
						<SettingsRow
							label="Allowlisted Repository Owners"
							description="One owner per line. Downloads are matched case-insensitively."
						>
							<div className="w-full max-w-2xl">
								<textarea
									value={allowRepoOwners.join("\n")}
									onChange={(event) =>
										editor.updateField(
											"model_download.allow_repo_owners",
											parseLineList(event.target.value),
										)
									}
									className="min-h-[140px] w-full rounded-md border border-border bg-surface px-3 py-2 font-sans text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
									placeholder={"trusted-owner\nanother-owner"}
								/>
							</div>
						</SettingsRow>
					</SettingsSectionGroup>
				</div>
			);
		}

		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Server">
					<SettingsRow
						label="Server Host"
						description="Host binding used by the backend HTTP and WebSocket server."
					>
						<div className="w-full max-w-md">
							<TextField
								value={serverHost}
								onChange={(event) =>
									editor.updateField("server.host", event.target.value)
								}
								placeholder="127.0.0.1"
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="Allowed Origins"
						description="Origins permitted to access the backend."
					>
						<div className="w-full max-w-2xl">
							<textarea
								value={allowedOrigins.join("\n")}
								onChange={(event) =>
									editor.updateField(
										"server.allowed_origins",
										parseLineList(event.target.value),
									)
								}
								className="min-h-[120px] w-full rounded-md border border-border bg-surface px-3 py-2 font-sans text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
								placeholder={"http://localhost:1420\nhttp://127.0.0.1:1420"}
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="CORS Allowed Origins"
						description="Origins explicitly allowed through the CORS layer."
					>
						<div className="w-full max-w-2xl">
							<textarea
								value={corsAllowedOrigins.join("\n")}
								onChange={(event) =>
									editor.updateField(
										"server.cors_allowed_origins",
										parseLineList(event.target.value),
									)
								}
								className="min-h-[120px] w-full rounded-md border border-border bg-surface px-3 py-2 font-sans text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
								placeholder={"http://localhost:1420\nhttps://app.example.com"}
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="WebSocket Allowed Origins"
						description="Origins permitted to establish WebSocket connections."
					>
						<div className="w-full max-w-2xl">
							<textarea
								value={wsAllowedOrigins.join("\n")}
								onChange={(event) =>
									editor.updateField(
										"server.ws_allowed_origins",
										parseLineList(event.target.value),
									)
								}
								className="min-h-[120px] w-full rounded-md border border-border bg-surface px-3 py-2 font-sans text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
								placeholder={"http://localhost:1420\nhttps://app.example.com"}
							/>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Execution">
				<SettingsRow
					label="Max Input Length"
					description="Upper bound for a single prompt payload"
				>
					<NumberField
						value={editor.readNumber("app.max_input_length", 4000)}
						onChange={(value) => editor.updateField("app.max_input_length", value)}
					/>
				</SettingsRow>
				<SettingsRow
					label="Graph Recursion Limit"
					description="Maximum number of graph steps before execution stops"
				>
					<NumberField
						value={editor.readNumber("app.graph_recursion_limit", 50)}
						onChange={(value) =>
							editor.updateField("app.graph_recursion_limit", value)
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="Tool Timeout"
					description="Timeout for tool execution in backend config units"
				>
					<NumberField
						value={editor.readNumber("app.tool_execution_timeout", 300)}
						onChange={(value) =>
							editor.updateField("app.tool_execution_timeout", value)
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="Graph Timeout"
					description="Timeout for graph execution in backend config units"
				>
					<NumberField
						value={editor.readNumber("app.graph_execution_timeout", 180000)}
						onChange={(value) =>
							editor.updateField("app.graph_execution_timeout", value)
						}
					/>
				</SettingsRow>
				<SettingsRow label="Permission TTL">
					<NumberField
						value={editor.readNumber("permissions.default_ttl_seconds", 86400)}
						onChange={(value) =>
							editor.updateField("permissions.default_ttl_seconds", value)
						}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};

function NumberField({
	value,
	onChange,
}: {
	value: number;
	onChange: (value: number) => void;
}) {
	return (
		<div className="w-full max-w-xs">
			<TextField
				type="number"
				value={value}
				onChange={(event) => onChange(Number(event.target.value) || 0)}
				min={0}
			/>
		</div>
	);
}
