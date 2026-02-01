import { Loader2, RotateCcw, Save } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitText } from "../../../components/ui/FitText";
import Modal from "../../../components/ui/Modal";
import { useSettings } from "../../../hooks/useSettings";
import { SettingsSidebar } from "./SettingsComponents";
import { NAV_ITEMS } from "./SettingsConstants";
import { SettingsLayout } from "./SettingsLayout";
import CharacterSettings from "./sections/CharacterSettings";
import CustomAgentSettings from "./sections/CustomAgentSettings";
import GeneralSettings from "./sections/GeneralSettings";
import McpSettings from "./sections/McpSettings";
import MemorySettings from "./sections/MemorySettings";
import ModelSettings from "./sections/ModelSettings";
import PrivacySettings from "./sections/PrivacySettings";

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
		updatePrivacy,
		updateCharacter,
		setActiveAgent,
		addCharacter,
		deleteCharacter,
		saveConfig,

		resetConfig,

		// Custom Agent functions
		updateCustomAgent,
		addCustomAgent,
		deleteCustomAgent,
	} = useSettings();

	const [activeSection, setActiveSection] = useState("general");
	const [toast, setToast] = useState<{
		message: string;
		type: "success" | "error";
	} | null>(null);

	const showToast = useCallback((message: string, type: "success" | "error") => {
		setToast({ message, type });
		setTimeout(() => setToast(null), 3000);
	}, []);

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
			privacy: "settings.sections.privacy.label",
			agents: "settings.sections.agents.label",
			custom_agents: "settings.sections.custom_agents.label",
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
			className="h-[85vh] flex flex-col"
			customContent={true}
		>
			<SettingsLayout>
				<div className="flex h-full min-h-0 overflow-hidden">
					{/* Sidebar */}
					<SettingsSidebar
						items={NAV_ITEMS.map((item) => ({
							...item,
							label: t(`settings.sections.${item.id}.label`),
						}))}
						activeItem={activeSection}
						onSelect={setActiveSection}
					/>

					{/* Main Content Area */}
					<div className="flex-1 flex flex-col min-w-0 bg-[#0A0A0C]">
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
									className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white transition-colors flex items-center gap-2"
								>
									<RotateCcw size={16} /> {t("common.retry")}
								</button>
							</div>
						)}

						{/* Content */}
						{!loading && !error && config && (
							<>
								{/* Fixed Header */}
								<header className="flex-none px-8 py-6 border-b border-white/5 flex flex-col gap-1">
									<div className="h-8 flex items-center min-w-0">
										<FitText
											className="text-2xl font-light text-white tracking-tight"
											minFontSize={14}
											maxFontSize={24}
										>
											{getSectionLabel(activeSection)}
										</FitText>
									</div>
									<div className="h-5 flex items-center min-w-0">
										<FitText className="text-sm text-gray-400" minFontSize={10} maxFontSize={14}>
											{t("settings.subtitle")}
										</FitText>
									</div>
								</header>

								{/* Scrollable Body */}
								<main className="settings-main">
									<div
										className={`w-full ${activeSection === "general" ? "max-w-full" : "max-w-4xl"} mx-auto space-y-8 pb-20`}
									>
										{activeSection === "general" && <GeneralSettings />}
										{activeSection === "privacy" && (
											<PrivacySettings privacyConfig={config.privacy} onUpdate={updatePrivacy} />
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
										{activeSection === "custom_agents" && (
											<CustomAgentSettings
												agents={config.custom_agents || {}}
												onUpdateAgent={updateCustomAgent}
												onAddAgent={addCustomAgent}
												onDeleteAgent={deleteCustomAgent}
											/>
										)}
										{activeSection === "mcp" && <McpSettings />}
										{activeSection === "models" && <ModelSettings />}
										{activeSection === "memory" && <MemorySettings />}
									</div>
								</main>

								{/* Fixed Footer */}
								<div className="flex-none px-8 py-4 glass-tepora border-x-0 border-b-0 rounded-t-none">
									<div className="flex items-center justify-end">
										<div className="text-xs text-gray-500 mr-auto">
											{hasChanges ? t("settings.save_bar.unsaved") : ""}
										</div>
										<div className="flex items-center gap-3">
											<button
												type="button"
												onClick={handleReset}
												className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
												disabled={!hasChanges || saving}
											>
												<RotateCcw size={16} /> {t("settings.save_bar.reset")}
											</button>
											<button
												type="button"
												onClick={handleSave}
												className={`
													px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all
													${hasChanges
														? "bg-gold-500 text-black hover:bg-gold-400 shadow-[0_0_15px_rgba(255,215,0,0.1)]"
														: "bg-white/5 text-gray-400 cursor-not-allowed"
													}
												`}
												disabled={!hasChanges || saving}
											>
												{saving ? (
													<Loader2 size={16} className="animate-spin" />
												) : (
													<Save size={16} />
												)}
												{saving ? t("settings.save_bar.saving") : t("settings.save_bar.save")}
											</button>
										</div>
									</div>
								</div>
							</>
						)}
					</div>
				</div>

				{/* Toast Notification */}
				{toast && (
					<div className={`settings-toast settings-toast--${toast.type}`}>{toast.message}</div>
				)}
			</SettingsLayout>
		</Modal>
	);
};

export default SettingsDialog;
