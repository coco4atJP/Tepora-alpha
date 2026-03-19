import React from "react";
import { Select } from "../../../../shared/ui/Select";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";

const LOADER_OPTIONS = [
	{ label: "Ollama", value: "ollama" },
	{ label: "LM Studio", value: "lmstudio" },
	{ label: "llama.cpp", value: "llama_cpp" },
];

export const SystemSettings: React.FC = () => {
	const editor = useSettingsEditor();
	const loader = editor.readString("llm_manager.loader", "ollama");
	const processTimeout = editor.readNumber(
		"llm_manager.process_terminate_timeout",
		5000,
	);
	const ollamaBaseUrl = editor.readString(
		"loaders.ollama.base_url",
		"http://localhost:11434",
	);
	const lmstudioBaseUrl = editor.readString(
		"loaders.lmstudio.base_url",
		"http://localhost:1234",
	);

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Integration">
				<SettingsRow
					label="Runtime Loader"
					description="Default backend loader used to resolve active models"
				>
					<div className="w-full max-w-sm">
						<Select
							value={loader}
							onChange={(event) =>
								editor.updateField("llm_manager.loader", event.target.value)
							}
						>
							{LOADER_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</Select>
					</div>
				</SettingsRow>
				<SettingsRow label="Ollama Base URL">
					<div className="w-full max-w-xl">
						<TextField
							value={ollamaBaseUrl}
							onChange={(event) =>
								editor.updateField("loaders.ollama.base_url", event.target.value)
							}
							placeholder="http://localhost:11434"
						/>
					</div>
				</SettingsRow>
				<SettingsRow label="LM Studio Base URL">
					<div className="w-full max-w-xl">
						<TextField
							value={lmstudioBaseUrl}
							onChange={(event) =>
								editor.updateField(
									"loaders.lmstudio.base_url",
									event.target.value,
								)
							}
							placeholder="http://localhost:1234"
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>

			<SettingsSectionGroup title="Updates">
				<SettingsRow
					label="Process Timeout"
					description="Milliseconds to wait before forcing external loader shutdown"
				>
					<div className="w-full max-w-xs">
						<TextField
							type="number"
							value={processTimeout}
							onChange={(event) =>
								editor.updateField(
									"llm_manager.process_terminate_timeout",
									Number(event.target.value) || 0,
								)
							}
							min={1}
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
