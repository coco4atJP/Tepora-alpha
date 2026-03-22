import React from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsEditorProvider,
	useSettingsEditor,
	type SettingsEditorContextValue,
} from "../model/editor";
import { SettingsCategoryNav } from "./SettingsCategoryNav";
import { SettingsContentPanel } from "./SettingsContentPanel";
import { SettingsTabNav } from "./SettingsTabNav";
import { useSettingsLayoutModel } from "./useSettingsLayoutModel";

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
	const {
		activeCategory,
		setActiveCategory,
		activeTab,
		setActiveTab,
		activeCategoryObj,
		footerMessage,
		handleClose,
	} = useSettingsLayoutModel({
		editor,
		onClose,
	});

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-bg text-text-main font-sans">
			<div className="relative z-10 flex-none px-8 pb-3 pt-5">
				<button
					onClick={handleClose}
					className="group flex items-center gap-2 text-sm tracking-wide text-text-muted transition-colors hover:text-text-main"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-hover:-translate-x-1">
						<line x1="19" y1="12" x2="5" y2="12" />
						<polyline points="12 19 5 12 12 5" />
					</svg>
					{t("v2.settings.return", "Return to Session")}
				</button>
			</div>

			<SettingsCategoryNav
				activeCategory={activeCategory}
				onSelectCategory={setActiveCategory}
			/>

			{activeCategoryObj ? (
				<SettingsTabNav
					activeCategory={activeCategoryObj}
					activeTab={activeTab}
					onSelectTab={setActiveTab}
				/>
			) : null}

			<div className="relative flex-1 overflow-y-auto no-scrollbar px-8 py-6">
				<div className="mx-auto min-h-[400px] max-w-5xl animate-in fade-in slide-in-from-bottom-4 pb-12 duration-500">
					<SettingsContentPanel
						editor={editor}
						activeCategory={activeCategory}
						activeTab={activeTab}
					/>
				</div>
			</div>

			<div className="relative z-20 flex-none border-t border-border/30 bg-bg/90 px-8 py-3 backdrop-blur-md">
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
