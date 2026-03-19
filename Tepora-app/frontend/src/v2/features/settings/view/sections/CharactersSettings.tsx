import React from "react";
import { TextField } from "../../../../shared/ui/TextField";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { readNestedValue, useSettingsEditor } from "../../model/editor";

export const CharactersSettings: React.FC = () => {
	const editor = useSettingsEditor();
	const activeProfile = editor.readString("active_agent_profile", "bunny_girl");
	const activeCharacterValue = editor.draft
		? readNestedValue(editor.draft, `characters.${activeProfile}`)
		: undefined;
	const activeCharacter =
		activeCharacterValue &&
		typeof activeCharacterValue === "object" &&
		!Array.isArray(activeCharacterValue)
			? (activeCharacterValue as Record<string, unknown>)
			: null;

	if (!activeCharacter) {
		return (
			<div className="rounded-3xl border border-theme-border/60 px-6 py-5 text-sm text-theme-subtext">
				No active persona is available yet.
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Personas">
				<SettingsRow
					label="Active Persona Name"
					description="Display name stored for the currently selected persona"
				>
					<div className="w-full max-w-md">
						<TextField
							value={String(activeCharacter.name ?? "")}
							onChange={(event) =>
								editor.updateField(
									`characters.${activeProfile}.name`,
									event.target.value,
								)
							}
							placeholder="Persona name"
						/>
					</div>
				</SettingsRow>
				<SettingsRow
					label="Persona Icon"
					description="Short icon or emoji used for the active persona"
				>
					<div className="w-full max-w-xs">
						<TextField
							value={String(activeCharacter.icon ?? "")}
							onChange={(event) =>
								editor.updateField(
									`characters.${activeProfile}.icon`,
									event.target.value,
								)
							}
							placeholder="e.g. 🐰"
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>

			<SettingsSectionGroup title="Custom Agents">
				<SettingsRow
					label="Persona Description"
					description="Short summary for the active persona profile"
				>
					<div className="w-full max-w-2xl">
						<TextField
							value={String(activeCharacter.description ?? "")}
							onChange={(event) =>
								editor.updateField(
									`characters.${activeProfile}.description`,
									event.target.value,
								)
							}
							placeholder="Persona summary"
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
