import React, { useState } from "react";
import { Button } from "../../../shared/ui";
import {
	SettingsEditorProvider,
	useSettingsEditor,
} from "../model/editor";
import { AdvancedSettings } from "./sections/AdvancedSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { CharactersSettings } from "./sections/CharactersSettings";
import { ContextSettings } from "./sections/ContextSettings";
import { DataSettings } from "./sections/DataSettings";
import { GeneralSettings } from "./sections/GeneralSettings";
import { MemorySettings } from "./sections/MemorySettings";
import { ModelsSettings } from "./sections/ModelsSettings";
import { PrivacySettings } from "./sections/PrivacySettings";
import { SystemSettings } from "./sections/SystemSettings";
import { ToolsSettings } from "./sections/ToolsSettings";

type NavCategory =
	| "General"
	| "Appearance"
	| "Characters"
	| "Models"
	| "Privacy"
	| "Tools"
	| "Memory"
	| "Context"
	| "Data"
	| "System"
	| "Advanced";

const CATEGORIES: NavCategory[] = [
	"General",
	"Appearance",
	"Characters",
	"Models",
	"Privacy",
	"Tools",
	"Memory",
	"Context",
	"Data",
	"System",
	"Advanced",
];

interface SettingsLayoutProps {
	onClose: () => void;
}

export const SettingsLayout: React.FC<SettingsLayoutProps> = ({ onClose }) => {
	return (
		<SettingsEditorProvider>
			<SettingsLayoutContent onClose={onClose} />
		</SettingsEditorProvider>
	);
};

const SettingsLayoutContent: React.FC<SettingsLayoutProps> = ({ onClose }) => {
	const editor = useSettingsEditor();
	const [activeCategory, setActiveCategory] = useState<NavCategory>("General");

	const renderContent = () => {
		if (editor.state === "loading" && !editor.draft) {
			return (
				<div className="flex min-h-[320px] items-center text-sm text-theme-subtext">
					Loading settings...
				</div>
			);
		}

		if (editor.state === "error" && !editor.draft) {
			return (
				<div className="rounded-3xl border border-red-500/20 bg-red-500/10 px-6 py-5 text-sm text-red-200">
					{editor.errorMessage ?? "Failed to load settings."}
				</div>
			);
		}

		switch (activeCategory) {
			case "General":
				return <GeneralSettings />;
			case "Appearance":
				return <AppearanceSettings />;
			case "Characters":
				return <CharactersSettings />;
			case "Models":
				return <ModelsSettings />;
			case "Privacy":
				return <PrivacySettings />;
			case "Tools":
				return <ToolsSettings />;
			case "Memory":
				return <MemorySettings />;
			case "Context":
				return <ContextSettings />;
			case "Data":
				return <DataSettings />;
			case "System":
				return <SystemSettings />;
			case "Advanced":
				return <AdvancedSettings />;
			default:
				return null;
		}
	};

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-theme-bg text-theme-text">
			<div className="z-10 flex shrink-0 flex-col bg-theme-bg px-8 pb-12 pt-[8vh] md:px-[12vw]">
				<button
					type="button"
					onClick={onClose}
					className="mb-12 flex w-max items-center gap-2 text-sm uppercase tracking-widest text-theme-subtext transition-colors hover:text-gold-500"
				>
					&larr; Return to Session
				</button>

				<div className="flex flex-wrap items-center gap-x-8 gap-y-6">
					{CATEGORIES.map((category) => (
						<button
							key={category}
							type="button"
							onClick={() => setActiveCategory(category)}
							className={`relative text-sm uppercase tracking-wider transition-colors duration-300 ${
								activeCategory === category
									? "text-gold-500"
									: "text-theme-subtext hover:text-theme-text"
							}`}
						>
							{category}
							{activeCategory === category ? (
								<div className="absolute -bottom-2 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-gold-500 shadow-[0_0_8px_rgba(212,191,128,0.5)]" />
							) : null}
						</button>
					))}
				</div>
			</div>

			<div className="hide-scrollbar flex-1 overflow-y-auto px-8 pb-10 md:px-[12vw]">
				<div className="flex min-h-full flex-col gap-16 md:flex-row md:gap-24">
					<div className="shrink-0 md:w-1/3">
						<h2 className="sticky top-0 py-4 font-display text-5xl font-light tracking-wide text-theme-text md:text-6xl">
							{activeCategory}
						</h2>
					</div>

					<div className="max-w-3xl flex-1 pt-8">{renderContent()}</div>
				</div>
			</div>

			<div className="shrink-0 border-t border-theme-border/60 bg-theme-bg/95 px-8 py-4 backdrop-blur md:px-[12vw]">
				<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div className="text-sm text-theme-subtext">
						{editor.errorMessage ? (
							<span className="text-red-300">{editor.errorMessage}</span>
						) : editor.state === "saving" ? (
							"Saving changes..."
						) : editor.hasUnsavedChanges ? (
							"Unsaved changes"
						) : (
							"All changes saved"
						)}
					</div>
					<Button
						type="button"
						onClick={() => void editor.save()}
						disabled={
							!editor.hasUnsavedChanges ||
							editor.state === "loading" ||
							editor.state === "saving"
						}
					>
						Save Changes
					</Button>
				</div>
			</div>

			<style>{`
				.hide-scrollbar::-webkit-scrollbar {
					display: none;
				}
				.hide-scrollbar {
					-ms-overflow-style: none;
					scrollbar-width: none;
				}
			`}</style>
		</div>
	);
};
