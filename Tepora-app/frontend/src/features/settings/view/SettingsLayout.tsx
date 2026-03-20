import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsEditorProvider,
	useSettingsEditor,
	type SettingsEditorContextValue,
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

const SETTINGS_CATEGORIES: { id: NavCategory; label: string; tabs: string[] }[] = [
	{ id: "General", label: "General", tabs: ["Basics", "Deliberate"] },
	{ id: "Appearance", label: "Appearance", tabs: ["Theme", "Typography", "Code Blocks", "Notifications", "Shortcuts"] },
	{ id: "Characters", label: "Characters", tabs: ["Personas", "Custom Agents"] },
	{ id: "Models", label: "Models", tabs: ["Hub", "Defaults", "Embedding", "Loader", "Advanced"] },
	{ id: "Privacy", label: "Privacy", tabs: ["Privacy", "Quarantine", "Permissions"] },
	{ id: "Tools", label: "Tools", tabs: ["Web Search", "Agent Skills", "MCP", "Credentials"] },
	{ id: "Memory", label: "Memory", tabs: ["Basics", "Decay Engine", "Retrieval"] },
	{ id: "Context", label: "Context", tabs: ["RAG", "Window Allocation"] },
	{ id: "Data", label: "Data", tabs: ["Indexing", "Paths", "Cache", "Backup"] },
	{ id: "System", label: "System", tabs: ["Integration", "Performance", "Updates"] },
	{ id: "Advanced", label: "Advanced", tabs: ["Execution", "Agent", "Model DL", "Features", "Server"] },
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
	const { t } = useTranslation();
	const editor: SettingsEditorContextValue = useSettingsEditor();
	const [activeCategory, setActiveCategory] = useState<NavCategory>("General");
	const [activeTab, setActiveTab] = useState<string>("Basics");

	useEffect(() => {
		const category = SETTINGS_CATEGORIES.find((item) => item.id === activeCategory);
		if (category && !category.tabs.includes(activeTab)) {
			setActiveTab(category.tabs[0]);
		}
	}, [activeCategory, activeTab]);

	useEffect(() => {
		if (!editor.hasUnsavedChanges || editor.state === "saving") {
			return;
		}

		const timeoutId = window.setTimeout(() => {
			void editor.save();
		}, 450);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [editor]);

	const activeCategoryObj = useMemo(
		() => SETTINGS_CATEGORIES.find((item) => item.id === activeCategory),
		[activeCategory],
	);

	const renderContent = () => {
		if (editor.state === "loading" && !editor.draft) {
			return (
				<div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">
					{t("v2.common.loading", "Loading...")}
				</div>
			);
		}

		if (editor.state === "error" && !editor.draft) {
			return (
				<div className="absolute inset-0 flex items-center justify-center">
					<div className="rounded-[28px] border border-red-500/20 bg-red-500/10 px-6 py-5 text-sm text-red-200">
						{editor.errorMessage ?? t("v2.settings.loadError", "Failed to load settings.")}
					</div>
				</div>
			);
		}

		switch (activeCategory) {
			case "General":
				return <GeneralSettings activeTab={activeTab === "Deliberate" ? "Thinking" : activeTab} />;
			case "Appearance":
				return <AppearanceSettings activeTab={activeTab} />;
			case "Characters":
				return <CharactersSettings activeTab={activeTab} />;
			case "Models":
				return <ModelsSettings activeTab={activeTab} />;
			case "Privacy":
				return <PrivacySettings activeTab={activeTab} />;
			case "Tools":
				return <ToolsSettings activeTab={activeTab} />;
			case "Memory":
				return <MemorySettings activeTab={activeTab} />;
			case "Context":
				return <ContextSettings activeTab={activeTab} />;
			case "Data":
				return <DataSettings activeTab={activeTab} />;
			case "System":
				return <SystemSettings activeTab={activeTab} />;
			case "Advanced":
				return <AdvancedSettings activeTab={activeTab} />;
			default:
				return null;
		}
	};

	const footerMessage = editor.errorMessage
		? editor.errorMessage
		: editor.state === "saving"
			? t("v2.settings.saving", "Saving changes...")
			: editor.hasUnsavedChanges
				? t("v2.settings.pendingSave", "Saving soon...")
				: t("v2.settings.allSaved", "All changes saved automatically");

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-bg text-text-main font-sans">
			<div className="relative z-10 flex-none px-12 pb-4 pt-8">
				<button
					onClick={() => {
						if (editor.hasUnsavedChanges && editor.state !== "saving") {
							void editor.save();
						}
						onClose();
					}}
					className="group flex items-center gap-2 text-sm tracking-wide text-text-muted transition-colors hover:text-text-main"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-hover:-translate-x-1">
						<line x1="19" y1="12" x2="5" y2="12" />
						<polyline points="12 19 5 12 12 5" />
					</svg>
					{t("v2.settings.return", "Return to Session")}
				</button>
			</div>

			<div className="relative z-10 flex-none border-b border-border/30 px-12 py-4">
				<div className="no-scrollbar flex items-center justify-center gap-8 overflow-x-auto">
					{SETTINGS_CATEGORIES.map((category) => (
						<button
							key={category.id}
							onClick={() => setActiveCategory(category.id)}
							className={`relative whitespace-nowrap px-2 py-1 text-xs uppercase tracking-[0.15em] transition-all duration-300 ${
								activeCategory === category.id
									? "font-medium text-gold"
									: "text-text-muted hover:text-text-main"
							}`}
						>
							{t(`v2.settings.categories.${category.id.toLowerCase()}.label`, category.label)}
							{activeCategory === category.id ? (
								<span className="absolute -bottom-[21px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-gold shadow-[0_0_8px_rgba(170,149,85,0.8)]" />
							) : null}
						</button>
					))}
				</div>
			</div>

			<div className="relative z-10 flex-none border-b border-border/30 bg-black/10 px-12 py-10">
				<div className="mx-auto flex w-full max-w-5xl items-baseline gap-12">
					<h2 className="shrink-0 border-r border-white/5 pr-8 font-serif text-4xl italic tracking-tight text-text-main">
						{activeCategoryObj?.id ? t(`v2.settings.categories.${activeCategoryObj.id.toLowerCase()}.label`, activeCategoryObj.label) : activeCategoryObj?.label}
					</h2>
					<div className="no-scrollbar flex items-center gap-8 overflow-x-auto pb-1">
						{activeCategoryObj?.tabs.map((tab) => (
							<button
								key={tab}
								onClick={() => setActiveTab(tab)}
								className={`whitespace-nowrap border-b-2 pb-1 text-base transition-all duration-300 ${
									activeTab === tab
										? "border-gold text-text-main"
										: "border-transparent text-text-muted hover:text-text-main"
								}`}
							>
								{t(`v2.settings.categories.${activeCategoryObj.id.toLowerCase()}.tabs.${tab.toLowerCase().replace(/\s+/g, '_')}`, tab)}
							</button>
						))}
					</div>
				</div>
			</div>

			<div className="relative flex-1 overflow-y-auto px-12 py-12">
				<div className="mx-auto min-h-[400px] max-w-5xl animate-in fade-in slide-in-from-bottom-4 pb-24 duration-500">
					{renderContent()}
				</div>
			</div>

			<div className="relative z-20 flex-none border-t border-border/30 bg-bg/90 px-12 py-4 backdrop-blur-md">
				<div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
					<div
						className={`text-xs font-medium uppercase tracking-wide ${
							editor.errorMessage ? "text-red-400" : "text-text-muted"
						}`}
					>
						{footerMessage}
					</div>
					<div className="text-xs uppercase tracking-[0.16em] text-text-muted/70">
						{t("v2.settings.autoSave", "Auto-save enabled")}
					</div>
				</div>
			</div>

			<style>{`
				.no-scrollbar::-webkit-scrollbar {
					display: none;
				}
				.no-scrollbar {
					-ms-overflow-style: none;
					scrollbar-width: none;
				}
			`}</style>
		</div>
	);
};
