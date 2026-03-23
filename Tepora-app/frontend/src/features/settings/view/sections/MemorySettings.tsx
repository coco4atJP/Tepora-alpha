import React from "react";
import { DialControl } from "../../../../shared/ui/DialControl";
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
					<div className="p-6 bg-surface/30 rounded-[24px] border border-border/40">
						<div className="flex flex-wrap justify-center gap-12">
							<DialControl
								label="Promote Threshold"
								min={0}
								max={1}
								step={0.01}
								value={promoteThreshold}
								onChange={(value) =>
									editor.updateField("episodic_memory.decay.promote_threshold", value)
								}
								description="Importance threshold used to strengthen memory retention"
							/>
						</div>
					</div>
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
					<div className="p-8 bg-surface/30 rounded-[24px] border border-border/40 mt-4">
						<div className="flex flex-wrap justify-center gap-16 md:gap-24">
							<DialControl
								label="Decay Rate"
								min={0}
								max={1}
								step={0.01}
								value={decayLambda}
								onChange={(value) =>
									editor.updateField("episodic_memory.decay.lambda_base", value)
								}
								description="Base decay applied to older episodic memories"
							/>
							<DialControl
								label="Promote Threshold"
								min={0}
								max={1}
								step={0.01}
								value={promoteThreshold}
								onChange={(value) =>
									editor.updateField("episodic_memory.decay.promote_threshold", value)
								}
								description="Importance threshold used to strengthen memory retention"
							/>
						</div>
					</div>
				) : null}
			</SettingsSectionGroup>
		</div>
	);
};
