import React from "react";
import { useTranslation } from "react-i18next";
import { LineSlider } from "../../../../shared/ui/LineSlider";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SelectionDot } from "../../../../shared/ui/SelectionDot";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { readNestedValue, useSettingsEditor } from "../../model/editor";

const LANGUAGE_OPTIONS = [
	{ label: "English", value: "en" },
	{ label: "Japanese", value: "ja" },
	{ label: "Spanish", value: "es" },
	{ label: "Chinese", value: "zh" },
];

interface GeneralSettingsProps {
	activeTab?: string;
}

export const GeneralSettings: React.FC<GeneralSettingsProps> = ({
	activeTab = "Basics",
}) => {
	const { t } = useTranslation();
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
	const historyLimit = editor.readNumber("app.history_limit", 6);

	if (activeTab === "Thinking") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title={t("v2.settings.thinking", "Deliberate Mode")}>
					<SettingsRow
						label={t("v2.settings.chatThinking", "Chat Deliberate Mode")}
						description={t(
							"v2.settings.chatThinkingDescription",
							"Enable deliberate mode by default for new chat sessions.",
						)}
					>
						<MinToggle
							checked={chatThinking}
							onChange={(checked) => editor.updateField("thinking.chat_default", checked)}
							label={chatThinking ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
						/>
					</SettingsRow>
					<SettingsRow
						label={t("v2.settings.searchThinking", "Search Deliberate Mode")}
						description={t(
							"v2.settings.searchThinkingDescription",
							"Enable deliberate mode by default for new search sessions.",
						)}
					>
						<MinToggle
							checked={searchThinking}
							onChange={(checked) => editor.updateField("thinking.search_default", checked)}
							label={searchThinking ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
						/>
					</SettingsRow>
					<SettingsRow
						label={t("v2.settings.historyLimit", "History Limit")}
						description={t(
							"v2.settings.historyLimitDescription",
							"Recent conversation pairs retained for context assembly.",
						)}
					>
						<LineSlider
							min={1}
							max={30}
							value={historyLimit}
							onChange={(value) => editor.updateField("app.history_limit", value)}
						/>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title={t("v2.settings.basics", "Basics")}>
				<SettingsRow
					label={t("v2.settings.language", "Language")}
					description={t("v2.settings.languageDescription", "User interface language")}
				>
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
					label={t("v2.settings.activeCharacter", "Active Character")}
					description={t(
						"v2.settings.activeCharacterDescription",
						"Default character used for chat and agent execution.",
					)}
				>
					{characters.map((character) => (
						<SelectionDot
							key={character.id}
							label={character.name}
							selected={activeProfile === character.id}
							onClick={() => editor.updateField("active_agent_profile", character.id)}
						/>
					))}
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
