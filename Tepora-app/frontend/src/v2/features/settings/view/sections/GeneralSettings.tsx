import React from "react";
import { SelectionDot } from "../../../../shared/ui/SelectionDot";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { readNestedValue, useSettingsEditor } from "../../model/editor";

const LANGUAGE_OPTIONS = [
	{ label: "English", value: "en" },
	{ label: "Japanese", value: "ja" },
	{ label: "Spanish", value: "es" },
	{ label: "Chinese", value: "zh" },
];

export const GeneralSettings: React.FC = () => {
	const editor = useSettingsEditor();
	const charactersValue = editor.draft
		? readNestedValue(editor.draft, "characters")
		: undefined;
	const characters =
		charactersValue && typeof charactersValue === "object" && !Array.isArray(charactersValue)
			? Object.entries(charactersValue as Record<string, unknown>).map(([id, value]) => ({
					id,
					name:
						value && typeof value === "object" && "name" in value
							? String((value as { name?: unknown }).name ?? id)
							: id,
				}))
			: [];

	const language = editor.readString("app.language", "en");
	const activeProfile = editor.readString(
		"active_agent_profile",
		characters[0]?.id ?? "bunny_girl",
	);
	const chatThinking = editor.readBoolean("thinking.chat_default", false);
	const searchThinking = editor.readBoolean("thinking.search_default", false);

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Basics">
				<SettingsRow label="Language" description="User interface language">
					{LANGUAGE_OPTIONS.map((option) => (
						<SelectionDot
							key={option.value}
							label={option.label}
							selected={language === option.value}
							onClick={() => editor.updateField("app.language", option.value)}
						/>
					))}
				</SettingsRow>
				<SettingsRow
					label="Active Persona"
					description="Default persona used for chat and agent execution"
				>
					{characters.map((character) => (
						<SelectionDot
							key={character.id}
							label={character.name}
							selected={activeProfile === character.id}
							onClick={() =>
								editor.updateField("active_agent_profile", character.id)
							}
						/>
					))}
				</SettingsRow>
			</SettingsSectionGroup>

			<SettingsSectionGroup title="Thinking">
				<SettingsRow
					label="Chat Thinking"
					description="Enable thinking by default for new chat sessions"
				>
					<MinToggle
						checked={chatThinking}
						onChange={(checked) =>
							editor.updateField("thinking.chat_default", checked)
						}
						label={chatThinking ? "Enabled" : "Disabled"}
					/>
				</SettingsRow>
				<SettingsRow
					label="Search Thinking"
					description="Enable thinking by default for new search sessions"
				>
					<MinToggle
						checked={searchThinking}
						onChange={(checked) =>
							editor.updateField("thinking.search_default", checked)
						}
						label={searchThinking ? "Enabled" : "Disabled"}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
