import React from "react";
import { useTranslation } from "react-i18next";
import { TextField } from "../../../../shared/ui/TextField";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { readNestedValue, useSettingsEditor } from "../../model/editor";

interface CharactersSettingsProps {
	activeTab?: string;
}

export const CharactersSettings: React.FC<CharactersSettingsProps> = ({
	activeTab = "Characters",
}) => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const charactersValue = editor.draft
		? readNestedValue(editor.draft, "characters")
		: undefined;
	const characters =
		charactersValue &&
		typeof charactersValue === "object" &&
		!Array.isArray(charactersValue)
			? Object.entries(charactersValue as Record<string, Record<string, unknown>>).map(
					([id, value]) => ({
						id,
						name: String(value.name ?? id),
						description: String(value.description ?? ""),
						icon: String(value.icon ?? "•"),
					}),
			  )
			: [];

	const activeProfile =
		editor.readString("active_character") ||
		editor.readString("active_character", characters[0]?.id ?? "");
	const activeCharacter = characters.find((character) => character.id === activeProfile) ?? null;

	const customAgentsValue = editor.draft
		? readNestedValue(editor.draft, "custom_agents")
		: undefined;
	const customAgents =
		customAgentsValue &&
		typeof customAgentsValue === "object" &&
		!Array.isArray(customAgentsValue)
			? Object.entries(customAgentsValue as Record<string, Record<string, unknown>>).map(
					([id, value]) => ({
						id,
						name: String(value.name ?? id),
						description: String(value.description ?? ""),
						enabled: value.enabled !== false,
						tags: Array.isArray(value.tags)
							? value.tags.map((tag) => String(tag))
							: [],
					}),
			  )
			: [];

	if (activeTab === "Custom Agents") {
		return (
			<SettingsSectionGroup title={t("v2.settings.customAgents", "Custom Agents")}>
				<div className="grid gap-4 md:grid-cols-2">
					{customAgents.length > 0 ? (
						customAgents.map((agent) => (
							<div
								key={agent.id}
								className="rounded-[24px] border border-primary/10 bg-white/55 p-5"
							>
								<div className="flex items-center justify-between gap-3">
									<div className="text-base font-medium text-text-main">
										{agent.name}
									</div>
									<div className="rounded-full border border-primary/15 px-2.5 py-0.5 text-[0.68rem] uppercase tracking-[0.16em] text-primary/80">
										{agent.enabled
											? t("v2.common.enabled", "Enabled")
											: t("v2.common.disabled", "Disabled")}
									</div>
								</div>
								<div className="mt-3 text-sm leading-7 text-text-muted">
									{agent.description || t("v2.character.noDescription", "No description")}
								</div>
								<div className="mt-4 text-xs uppercase tracking-[0.16em] text-text-muted">
									{agent.tags.length > 0 ? agent.tags.join(", ") : t("v2.settings.noTags", "No tags")}
								</div>
							</div>
						))
					) : (
						<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
							{t("v2.settings.noCustomAgents", "No custom agents are configured yet.")}
						</div>
					)}
				</div>
			</SettingsSectionGroup>
		);
	}

	if (!activeCharacter) {
		return (
			<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
				{t("v2.settings.noCharacters", "No active character is available yet.")}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-8">
			<SettingsSectionGroup title={t("v2.settings.characters", "Characters")}>
				<div className="grid gap-4 md:grid-cols-2">
					{characters.map((character) => {
						const selected = character.id === activeProfile;
						return (
							<button
								type="button"
								key={character.id}
								onClick={() => {
									editor.updateField("active_character", character.id);
									editor.updateField("active_character", character.id);
								}}
								className={`rounded-[24px] border p-5 text-left transition-colors ${
									selected
										? "border-primary/20 bg-primary/8"
										: "border-primary/10 bg-white/50 hover:bg-white/65"
								}`}
							>
								<div className="flex items-center gap-3">
									<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-base text-primary">
										<span aria-hidden="true">{character.icon}</span>
									</div>
									<div>
										<div className="text-base font-medium text-text-main">
											{character.name}
										</div>
										<div className="mt-1 text-sm text-text-muted">
											{character.description || t("v2.character.noDescription", "No description")}
										</div>
									</div>
								</div>
							</button>
						);
					})}
				</div>
			</SettingsSectionGroup>

			<SettingsSectionGroup title={t("v2.settings.activeCharacter", "Active Character")}>
				<SettingsRow
					label={t("v2.settings.characterName", "Character Name")}
					description={t("v2.settings.characterNameDescription", "Display name shown above replies.")}
				>
					<div className="w-full max-w-md">
						<TextField
							value={activeCharacter.name}
							onChange={(event) =>
								editor.updateField(
									`characters.${activeProfile}.name`,
									event.target.value,
								)
							}
							placeholder="Character name"
						/>
					</div>
				</SettingsRow>
				<SettingsRow
					label={t("v2.settings.characterIcon", "Character Icon")}
					description={t("v2.settings.characterIconDescription", "Small icon used in quick switching.")}
				>
					<div className="w-full max-w-xs">
						<TextField
							value={activeCharacter.icon}
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
				<SettingsRow
					label={t("v2.settings.characterDescription", "Character Description")}
					description={t(
						"v2.settings.characterDescriptionDescription",
						"Short summary for the selected character.",
					)}
				>
					<div className="w-full max-w-2xl">
						<TextField
							value={activeCharacter.description}
							onChange={(event) =>
								editor.updateField(
									`characters.${activeProfile}.description`,
									event.target.value,
								)
							}
							placeholder="Character description"
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
