import { Loader2, RotateCcw, Save } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitText } from "../../../components/ui/FitText";
import Modal from "../../../components/ui/Modal";
import {
	useAgentProfiles,
	useAgentSkills,
	useSettingsConfigActions,
	useSettingsState,
} from "../../../context/SettingsContext";
import { SettingsSidebar } from "./SettingsComponents";
import { getNavItems } from "./SettingsConstants";
import { SettingsLayout } from "./SettingsLayout";
import CharacterSettings from "./sections/CharacterSettings";
import AgentSkillsSettings from "./sections/AgentSkillsSettings";
import GeneralSettings from "./sections/GeneralSettings";
import DataStorageSettings from "./sections/DataStorageSettings";
import SystemPerformanceSettings from "./sections/SystemPerformanceSettings";
import McpSettings from "./sections/McpSettings";
import MemorySettings from "./sections/MemorySettings";
import ModelSettings from "./sections/ModelSettings";
import { default as OtherSettings } from "./sections/OtherSettings";
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
	} = useSettingsState();
	const { fetchConfig, updatePrivacy, saveConfig, resetConfig } = useSettingsConfigActions();
	const { agentSkills } = useAgentSkills();
	const { updateCharacter, setActiveAgent, addCharacter, deleteCharacter } = useAgentProfiles();

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
			data_storage: "settings.sections.extended.storage_title",
			system_performance: "settings.sections.extended.performance_title",
			agents: "settings.sections.agents.label",
			agent_skills: "settings.sections.execution_agents.label",
			mcp: "settings.sections.mcp.label",
			models: "settings.sections.models.label",
			memory: "settings.sections.memory.label",
			other: "settings.sections.other.label",
		};
		const fallbackLabel = getNavItems(t).find((item) => item.id === id)?.label || id;
		return t(keyMap[id] || id, fallbackLabel);
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
				<div className="flex-1 flex h-full w-full min-w-0 min-h-0 overflow-hidden">
					{/* Sidebar */}
					<SettingsSidebar
						items={getNavItems(t).map((item) => ({
							...item,
							group: item.group ? t(`settings.groups.${item.group}`, item.group) : undefined,
						}))}
						activeItem={activeSection}
						onSelect={setActiveSection}
					/>

					{/* Main Content Area */}
					<div className="flex-1 flex flex-col min-w-0 bg-bg/90 text-text-main">
						{/* Loading State */}
						{loading && (
							<div className="flex items-center justify-center h-full">
								<Loader2 className="animate-spin text-gold-400" size={32} />
							</div>
						)}

						{/* Error State */}
						{error && !loading && (
							<div className="flex items-center justify-center flex-col gap-4 h-full">
								<p className="text-semantic-error">{error}</p>
								<button
									type="button"
									onClick={fetchConfig}
									className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface/70 px-4 py-2 text-text-main transition-colors hover:border-primary/20 hover:bg-surface"
								>
									<RotateCcw size={16} /> {t("common.retry")}
								</button>
							</div>
						)}

						{/* Content */}
						{!loading && !error && config && (
							<>
								{/* Fixed Header */}
								<header className="flex-none border-b border-border/50 bg-surface/30 px-8 py-6 flex flex-col gap-1">
									<div className="h-8 flex items-center min-w-0">
										<FitText
											className="font-serif text-2xl tracking-tight text-text-main"
											minFontSize={14}
											maxFontSize={24}
										>
											{getSectionLabel(activeSection)}
										</FitText>
									</div>
									<div className="h-5 flex items-center min-w-0">
										<FitText className="text-sm text-text-muted" minFontSize={10} maxFontSize={14}>
											{t("settings.subtitle")}
										</FitText>
									</div>
								</header>

								{/* Scrollable Body */}
								<main className="settings-main">
									<div className="w-full max-w-full space-y-6 pb-12">
										{activeSection === "general" && <GeneralSettings />}
										{activeSection === "privacy" && (
											<PrivacySettings privacyConfig={config.privacy} onUpdate={updatePrivacy} />
										)}
										{activeSection === "data_storage" && <DataStorageSettings />}
										{activeSection === "system_performance" && <SystemPerformanceSettings />}
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
										{activeSection === "agent_skills" && (
											<AgentSkillsSettings agents={agentSkills} />
										)}
										{activeSection === "mcp" && <McpSettings />}
										{activeSection === "models" && <ModelSettings />}
										{activeSection === "memory" && <MemorySettings />}
										{activeSection === "other" && <OtherSettings />}
									</div>
								</main>

								{/* Fixed Footer */}
								<div className="glass-tepora relative z-10 mt-auto shrink-0 rounded-none border-x-0 border-b-0 border-t border-border/50 bg-surface/85 px-8 py-4 shadow-[0_-10px_24px_rgba(28,25,23,0.12)]">
									<div className="flex items-center justify-end">
										<div className="mr-auto text-xs text-text-muted">
											{hasChanges ? t("settings.save_bar.unsaved") : ""}
										</div>
										<div className="flex items-center gap-3">
											<button
												type="button"
												onClick={handleReset}
												className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface/60 px-4 py-2 text-sm text-text-muted transition-colors hover:border-primary/20 hover:bg-surface hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
												disabled={!hasChanges || saving}
											>
												<RotateCcw size={16} /> {t("settings.save_bar.reset")}
											</button>
											<button
												type="button"
												onClick={handleSave}
												className={`
													flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all
													${hasChanges
														? "border-primary/20 bg-primary text-bg shadow-sm hover:bg-primary/90"
														: "cursor-not-allowed border-border/50 bg-surface/50 text-text-muted"
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
