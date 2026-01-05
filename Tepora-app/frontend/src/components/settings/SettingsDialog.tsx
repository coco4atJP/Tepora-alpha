import { Loader2, RotateCcw, Save } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import Modal from "../ui/Modal";
import { SettingsSidebar } from "./SettingsComponents";
import { NAV_ITEMS } from "./SettingsConstants";
import { SettingsLayout } from "./SettingsLayout";
import CharacterSettings from "./sections/CharacterSettings";
import GeneralSettings from "./sections/GeneralSettings";
import McpSettings from "./sections/McpSettings";
import MemorySettings from "./sections/MemorySettings";
import ModelSettings from "./sections/ModelSettings";

interface SettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
	const { t } = useTranslation();
	const {
		config,
		loading,
		error,
		hasChanges,
		saving,
		fetchConfig,
		updateApp,
		updateLlmManager,
		updateChatHistory,
		updateEmLlm,
		updateModel,
		updateTools,
		updateCharacter,
		setActiveAgent,
		addCharacter,
		deleteCharacter,
		saveConfig,
		resetConfig,
	} = useSettings();

	const [activeSection, setActiveSection] = useState("general");
	const [toast, setToast] = useState<{
		message: string;
		type: "success" | "error";
	} | null>(null);

	const showToast = useCallback(
		(message: string, type: "success" | "error") => {
			setToast({ message, type });
			setTimeout(() => setToast(null), 3000);
		},
		[],
	);

	const handleSave = useCallback(async () => {
		const success = await saveConfig();
		if (success) {
			showToast(t("settings.toast.save_success"), "success");
		} else {
			showToast(t("settings.toast.save_error"), "error");
		}
	}, [saveConfig, showToast, t]);

	const handleReset = useCallback(() => {
		resetConfig();
	}, [resetConfig]);

	const handleClose = useCallback(() => {
		// If there are unsaved changes, confirm before closing
		if (hasChanges) {
			const confirmed = window.confirm(t("settings.confirm_discard"));
			if (!confirmed) return;
			resetConfig();
		}
		onClose();
	}, [hasChanges, onClose, resetConfig, t]);

	// Helper to get translated section label
	const getSectionLabel = (id: string) => {
		const keyMap: Record<string, string> = {
			general: "settings.sections.general.label",
			agents: "settings.sections.agents.label",
			mcp: "settings.sections.mcp.label",
			models: "settings.sections.models.label",
			memory: "settings.sections.memory.label",
		};
		return t(keyMap[id] || id);
	};

	return (
		<Modal
			isOpen={isOpen}
			onClose={handleClose}
			title={t("common.settings")}
			size="xl"
		>
			<SettingsLayout>
				{/* Sidebar */}
				<SettingsSidebar
					items={NAV_ITEMS.map((item) => ({
						...item,
						label: t(`settings.sections.${item.id}.label`),
					}))}
					activeItem={activeSection}
					onSelect={setActiveSection}
				/>

				{/* Content Wrapper */}
				<div className="settings-content-wrapper">
					<main className="settings-main">
						{/* Loading State */}
						{loading && (
							<div className="flex items-center justify-center h-full">
								<Loader2 className="animate-spin text-gold-400" size={32} />
							</div>
						)}

						{/* Error State */}
						{error && !loading && (
							<div className="flex items-center justify-center flex-col gap-4 h-full">
								<p className="text-red-400">{error}</p>
								<button
									type="button"
									onClick={fetchConfig}
									className="settings-save-btn settings-save-btn--secondary"
								>
									<RotateCcw size={16} /> {t("common.retry")}
								</button>
							</div>
						)}

						{/* Content */}
						{!loading && !error && config && (
							<>
								<header className="settings-header">
									<h1 className="settings-header__title">
										{getSectionLabel(activeSection)}
									</h1>
									<p className="settings-header__subtitle">
										{t("settings.subtitle")}
									</p>
								</header>

								<div className="relative">
									{activeSection === "general" && (
										<GeneralSettings
											config={config.app}
											onChange={updateApp}
											toolsConfig={config.tools}
											onUpdateTools={updateTools}
										/>
									)}

									{activeSection === "models" && (
										<ModelSettings
											llmConfig={config.llm_manager}
											modelsConfig={config.models_gguf}
											onUpdateLlm={updateLlmManager}
											onUpdateModel={updateModel}
										/>
									)}

									{activeSection === "agents" && (
										<CharacterSettings
											profiles={config.characters}
											activeProfileId={config.active_agent_profile}
											onUpdateProfile={updateCharacter}
											onSetActive={setActiveAgent}
											onAddProfile={addCharacter}
											onDeleteProfile={deleteCharacter}
										/>
									)}

									{activeSection === "mcp" && <McpSettings />}

									{activeSection === "memory" && (
										<MemorySettings
											emConfig={config.em_llm}
											historyConfig={config.chat_history}
											onUpdateEm={updateEmLlm}
											onUpdateHistory={updateChatHistory}
										/>
									)}
								</div>
							</>
						)}
					</main>

					{/* Save Bar */}
					<div className="settings-save-bar">
						<button
							type="button"
							onClick={handleReset}
							className="settings-save-btn settings-save-btn--secondary"
							disabled={!hasChanges || saving}
						>
							<RotateCcw size={16} /> {t("settings.save_bar.reset")}
						</button>
						<button
							type="button"
							onClick={handleSave}
							className="settings-save-btn"
							disabled={!hasChanges || saving}
						>
							{saving ? (
								<Loader2 size={16} className="animate-spin" />
							) : (
								<Save size={16} />
							)}
							{saving
								? t("settings.save_bar.saving")
								: t("settings.save_bar.save")}
						</button>
					</div>
				</div>

				{/* Toast Notification */}
				{toast && (
					<div className={`settings-toast settings-toast--${toast.type}`}>
						{toast.message}
					</div>
				)}
			</SettingsLayout>
		</Modal>
	);
};

export default SettingsDialog;
