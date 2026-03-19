import React from "react";
import { Select } from "../../../../shared/ui/Select";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { useSettingsEditor } from "../../model/editor";
import { ModelManagementSection } from "../ModelManagementSection";

export const ModelsSettings: React.FC = () => {
	const editor = useSettingsEditor();
	const hasModels =
		editor.textModels.length > 0 || editor.embeddingModels.length > 0;

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Hub">
				<SettingsRow
					label="Installed Models"
					description="Current registry reported by the setup backend"
				>
					<div className="flex flex-wrap gap-6 text-sm text-theme-subtext">
						<span>{editor.textModels.length} text models</span>
						<span>{editor.embeddingModels.length} embedding models</span>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>

			<SettingsSectionGroup title="Defaults">
				<SettingsRow
					label="Global Default Model"
					description="Active text runtime used for characters and chat"
				>
					<div className="w-full max-w-md">
						<Select
							value={editor.activeTextModelId ?? ""}
							onChange={(event) =>
								void editor.activateModel(event.target.value, "text")
							}
							disabled={!editor.textModels.length || editor.isModelUpdating}
						>
							{editor.textModels.length ? null : (
								<option value="">No text models available</option>
							)}
							{editor.textModels.map((model) => (
								<option key={model.id} value={model.id}>
									{model.display_name}
								</option>
							))}
						</Select>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>

			<SettingsSectionGroup title="Embedding">
				<SettingsRow
					label="Vector Model"
					description="Active embedding runtime used for retrieval and RAG"
				>
					<div className="w-full max-w-md">
						<Select
							value={editor.activeEmbeddingModelId ?? ""}
							onChange={(event) =>
								void editor.activateModel(event.target.value, "embedding")
							}
							disabled={!editor.embeddingModels.length || editor.isModelUpdating}
						>
							{editor.embeddingModels.length ? null : (
								<option value="">No embedding models available</option>
							)}
							{editor.embeddingModels.map((model) => (
								<option key={model.id} value={model.id}>
									{model.display_name}
								</option>
							))}
						</Select>
					</div>
				</SettingsRow>
				{hasModels ? (
					<div className="text-sm text-theme-subtext">
						Model role changes apply immediately through the setup API.
					</div>
				) : null}
			</SettingsSectionGroup>

			<SettingsSectionGroup title="Management">
				<ModelManagementSection />
			</SettingsSectionGroup>
		</div>
	);
};
