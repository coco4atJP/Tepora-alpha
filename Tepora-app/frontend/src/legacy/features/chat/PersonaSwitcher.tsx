import { AlertCircle, Check, Edit2, Plus, RefreshCw, Trash2, User } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useAgentProfiles,
	useSettingsConfigActions,
	useSettingsState,
} from "../../context/SettingsContext";
import type { CharacterConfig } from "../../types";
import { logger } from "../../utils/logger";
import { CharacterEditOverlay, type CharacterEditState } from "../settings/components/subcomponents/CharacterEditOverlay";
import type { AgentProfile } from "../settings/components/SettingsComponents";

const PersonaSwitcher: React.FC = () => {
	const { t } = useTranslation();
	const { config } = useSettingsState();
	const { setActiveAgent, updateCharacter, addCharacter, deleteCharacter, activeAgentProfile } =
		useAgentProfiles();
	const { saveConfig } = useSettingsConfigActions();

	// State for UI
	const [isOpen, setIsOpen] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// State for overlay
	const [editState, setEditState] = useState<CharacterEditState | null>(null);

	const showError = useCallback((message: string) => {
		setErrorMessage(message);
		setTimeout(() => setErrorMessage(null), 4000);
	}, []);

	if (!config) {
		return null; // Or a loading spinner
	}

	const characters = config.characters || {};
	const currentPersonaId = activeAgentProfile || config.active_agent_profile;
	const existingKeys = Object.keys(characters);

	const characterToAgentProfile = (charConfig: CharacterConfig): AgentProfile => ({
		label: charConfig.name,
		description: charConfig.description,
		icon: charConfig.icon,
		avatar_path: charConfig.avatar_path,
		persona: {
			prompt: charConfig.system_prompt,
		},
		tool_policy: {
			allow: [],
			deny: [],
		},
	});

	const handleCreate = () => {
		setEditState({
			key: "",
			profile: {
				label: t("settings.sections.agents.default_name", "New Character"),
				description: "",
				icon: "👤",
				avatar_path: "",
				persona: {
					prompt: t("settings.sections.agents.default_prompt", "You are a helpful assistant."),
				},
				tool_policy: {
					allow: [],
					deny: [],
				},
			},
			model_config_name: "",
			isNew: true,
		});
		setIsOpen(false);
	};

	const handleEdit = (key: string, character: CharacterConfig, e: React.MouseEvent) => {
		e.stopPropagation();
		setEditState({
			key,
			profile: characterToAgentProfile(character),
			model_config_name: character.model_config_name || "",
			isNew: false,
		});
		setIsOpen(false);
	};

	const handleSaveEdit = async (targetKey: string, savedState: CharacterEditState) => {
		setIsLoading(true);
		try {
			if (savedState.isNew) {
				addCharacter(targetKey);
			}

			updateCharacter(targetKey, {
				name: savedState.profile.label,
				description: savedState.profile.description,
				system_prompt: savedState.profile.persona.prompt || "",
				model_config_name: savedState.model_config_name || undefined,
				icon: savedState.profile.icon,
				avatar_path: savedState.profile.avatar_path,
			});

			const success = await saveConfig();
			if (success) {
				setEditState(null);
			} else {
				showError(t("common.error_saving", "Failed to save."));
			}
		} catch (error) {
			logger.error("Failed to save character:", error);
			showError(t("common.error_saving", "Failed to save character."));
		} finally {
			setIsLoading(false);
		}
	};

	const handleDeleteRequest = (key: string, e: React.MouseEvent) => {
		e.stopPropagation();
		if (key === currentPersonaId) return;

		// Ensure at least one character remains
		if (Object.keys(characters).length <= 1) {
			return;
		}

		setDeleteTarget(key);
		setIsOpen(false);
	};

	const executeDelete = async () => {
		if (!deleteTarget) return;

		setIsLoading(true);
		try {
			deleteCharacter(deleteTarget);
			const success = await saveConfig();
			if (!success) {
				logger.error("Failed to save deletion");
			}
			setDeleteTarget(null);
		} catch (error) {
			logger.error("Failed to delete character:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const characterEntries = Object.entries(characters);

	return (
		<>
			{/* Main Switcher Button */}
			<div className="relative">
				<button
					type="button"
					onClick={() => setIsOpen(!isOpen)}
					className="glass-button p-2 flex items-center gap-2 hover:bg-white/10 transition-all group"
					title={t("personas.switch")}
				>
					<div className="w-8 h-8 rounded-full bg-gradient-to-br from-tea-400 to-tea-700 flex items-center justify-center border border-white/10 shadow-lg">
						<User className="w-4 h-4 text-white" />
					</div>
				</button>

				{/* Dropdown Menu */}
				{isOpen && (
					<>
						{/* FIX: Removed unnecessary biome-ignore comments and added onKeyDown handler to strictly satisfy a11y requirements for role="button" elements */}
						<div
							className="fixed inset-0 z-40"
							role="button"
							tabIndex={-1}
							aria-label={t("common.close", "Close")}
							onClick={() => setIsOpen(false)}
							onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									setIsOpen(false);
								}
							}}
						/>
						<div className="absolute bottom-full left-0 mb-2 w-max min-w-[16rem] max-w-sm glass-panel rounded-xl overflow-hidden animate-fade-in z-50">
							<div className="p-3 border-b border-white/5 flex justify-between items-center bg-black/40">
								<h3 className="text-xs font-bold text-tea-200 uppercase tracking-wider">
									{t("personas.select")}
								</h3>
								<button
									type="button"
									onClick={handleCreate}
									className="p-1 hover:bg-white/10 rounded-full text-green-400 transition-colors"
									title={t("personas.create")}
								>
									<Plus size={14} />
								</button>
							</div>

							<div className="max-h-60 overflow-y-auto custom-scrollbar p-1">
								{characterEntries.map(([key, character]) => (
									<div
										key={key}
										role="option"
										tabIndex={0}
										aria-selected={currentPersonaId === key}
										onClick={async () => {
											if (!config) return;

											// Create updated config for immediate persistence
											const newConfig = {
												...config,
												active_agent_profile: key,
											};

											setActiveAgent(key);
											await saveConfig(newConfig); // Persist selection immediately with override
											setIsOpen(false);
										}}
										onKeyDown={async (e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												if (!config) return;
												const newConfig = {
													...config,
													active_agent_profile: key,
												};
												setActiveAgent(key);
												await saveConfig(newConfig);
												setIsOpen(false);
											}
										}}
										className={`group w-full text-left flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all ${currentPersonaId === key ? "bg-white/10" : "hover:bg-white/5"
											}`}
									>
										<div className="flex items-center gap-3 overflow-hidden">
											<div
												className={`w-8 h-8 rounded-full flex items-center justify-center ${currentPersonaId === key
													? "bg-gold-500 text-black"
													: "bg-tea-800 text-tea-200"
													} shrink-0`}
											>
												{character.icon || <User size={14} />}
											</div>
											<div className="min-w-0">
												<div
													className={`text-sm font-medium break-words ${currentPersonaId === key ? "text-gold-300" : "text-gray-200"
														}`}
												>
													{character.name}
												</div>
											</div>
										</div>

										{currentPersonaId === key && (
											<Check className="w-4 h-4 text-gold-400 ml-2 shrink-0" />
										)}

										<div className="hidden group-hover:flex items-center gap-1 ml-2">
											<button
												type="button"
												onClick={(e) => handleEdit(key, character, e)}
												className="p-1 hover:text-blue-400 text-gray-500 transition-colors"
												aria-label={t("common.edit", "Edit")}
											>
												<Edit2 size={12} />
											</button>
											{/* Delete button: Only show if NOT active profile */}
											{key !== currentPersonaId && (
												<button
													type="button"
													onClick={(e) => handleDeleteRequest(key, e)}
													className="p-1 hover:text-red-400 text-gray-500 transition-colors"
													aria-label={t("common.delete", "Delete")}
												>
													<Trash2 size={12} />
												</button>
											)}
										</div>
									</div>
								))}
							</div>
						</div>
					</>
				)}
			</div>

			<CharacterEditOverlay
				isOpen={!!editState}
				editState={editState}
				onClose={() => setEditState(null)}
				onSave={handleSaveEdit}
				existingKeys={existingKeys}
				showError={showError}
			/>

			{/* Delete Confirmation Modal */}
			{deleteTarget && (
				<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
					<div className="glass-panel w-full max-w-sm p-6 space-y-4 animate-modal-enter text-center">
						<div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
							<Trash2 className="w-6 h-6 text-red-400" />
						</div>

						<h3 className="text-lg font-bold text-white">
							{t("personas.confirm_delete_title") || "Delete Persona?"}
						</h3>
						<p className="text-gray-400 text-sm">
							{t("personas.confirm_delete") ||
								"Are you sure you want to delete this persona? This action cannot be undone."}
						</p>

						<div className="flex justify-center gap-3 pt-4">
							<button
								type="button"
								onClick={() => setDeleteTarget(null)}
								className="px-4 py-2 rounded-lg hover:bg-white/5 text-gray-400 text-sm transition-colors"
								disabled={isLoading}
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={executeDelete}
								className="glass-button px-6 py-2 bg-red-500/20 text-red-300 hover:bg-red-500/40 text-sm font-medium"
								disabled={isLoading}
							>
								{isLoading ? (
									<RefreshCw className="animate-spin w-4 h-4" />
								) : (
									t("common.delete") || "Delete"
								)}
							</button>
						</div>
					</div>
				</div>
			)}

			{errorMessage && (
				<div className="fixed bottom-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg bg-red-900/90 border border-red-500/50 text-red-200 shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200">
					<AlertCircle size={18} className="text-red-400" />
					<span className="text-sm">{errorMessage}</span>
				</div>
			)}
		</>
	);
};

export default PersonaSwitcher;
