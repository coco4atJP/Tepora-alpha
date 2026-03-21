import React from "react";
import { LineSlider } from "../../../../shared/ui/LineSlider";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { useSettingsEditor } from "../../model/editor";

interface MemorySettingsProps {
	activeTab?: string;
}

export const MemorySettings: React.FC<MemorySettingsProps> = ({
	activeTab = "Basics",
}) => {
	const editor = useSettingsEditor();
	const episodicMemory = editor.readBoolean("app.episodic_memory_enabled", true);
	const historyLimit = editor.readNumber("app.history_limit", 6);
	const entityLimit = editor.readNumber("app.entity_extraction_limit", 6);
	const decayLambda = editor.readNumber("episodic_memory.decay.lambda_base", 0.1);
	const promoteThreshold = editor.readNumber("episodic_memory.decay.promote_threshold", 0.7);

	if (activeTab === "Retrieval") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Retrieval">
					<SettingsRow
						label="Promote Threshold"
						description="Importance threshold used to strengthen memory retention"
					>
						<LineSlider
							min={0}
							max={1}
							step={0.01}
							value={promoteThreshold}
							onChange={(value) =>
								editor.updateField("episodic_memory.decay.promote_threshold", value)
							}
						/>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title={activeTab === "Decay Engine" ? "Decay Engine" : "Basics"}>
				{activeTab === "Basics" ? (
					<>
				<SettingsRow
					label="Episodic Memory"
					description="Continuously learn from conversations and reuse memory"
				>
					<MinToggle
						checked={episodicMemory}
						onChange={(checked) =>
							editor.updateField("app.episodic_memory_enabled", checked)
						}
						label={episodicMemory ? "Active" : "Paused"}
					/>
				</SettingsRow>
				<SettingsRow
					label="History Limit"
					description="Recent conversation pairs included in memory processing"
				>
					<LineSlider
						min={1}
						max={30}
						value={historyLimit}
						onChange={(value) => editor.updateField("app.history_limit", value)}
					/>
				</SettingsRow>
				<SettingsRow
					label="Entity Extraction"
					description="Maximum number of entities extracted from recent history"
				>
					<LineSlider
						min={1}
						max={20}
						value={entityLimit}
						onChange={(value) =>
							editor.updateField("app.entity_extraction_limit", value)
						}
					/>
				</SettingsRow>
					</>
				) : null}
				{activeTab === "Decay Engine" ? (
					<>
				<SettingsRow
					label="Decay Rate"
					description="Base decay applied to older episodic memories"
				>
					<LineSlider
						min={0}
						max={1}
						step={0.01}
						value={decayLambda}
						onChange={(value) =>
							editor.updateField("episodic_memory.decay.lambda_base", value)
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="Promote Threshold"
					description="Importance threshold used to strengthen memory retention"
				>
					<LineSlider
						min={0}
						max={1}
						step={0.01}
						value={promoteThreshold}
						onChange={(value) =>
							editor.updateField("episodic_memory.decay.promote_threshold", value)
						}
					/>
				</SettingsRow>
					</>
				) : null}
			</SettingsSectionGroup>
		</div>
	);
};
