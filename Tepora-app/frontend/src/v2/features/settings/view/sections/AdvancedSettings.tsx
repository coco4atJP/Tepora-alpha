import React from "react";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { Select } from "../../../../shared/ui/Select";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";

export const AdvancedSettings: React.FC = () => {
	const editor = useSettingsEditor();

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
				<SettingsRow
					label="Web Fetch Max Chars"
					description="Maximum characters retained from web fetch results"
				>
					<NumberField
						value={editor.readNumber("app.web_fetch_max_chars", 6000)}
						onChange={(value) =>
							editor.updateField("app.web_fetch_max_chars", value)
						}
					/>
				</SettingsRow>
				<SettingsRow label="Web Fetch Max Bytes">
					<NumberField
						value={editor.readNumber("app.web_fetch_max_bytes", 1000000)}
						onChange={(value) =>
							editor.updateField("app.web_fetch_max_bytes", value)
						}
					/>
				</SettingsRow>
				<SettingsRow label="Web Fetch Timeout">
					<NumberField
						value={editor.readNumber("app.web_fetch_timeout_secs", 10)}
						onChange={(value) =>
							editor.updateField("app.web_fetch_timeout_secs", value)
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
