import { AlertCircle, Check, Edit2, Plus, Trash2, Users } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import Modal from "../../../../components/ui/Modal";
import { useSettings } from "../../../../hooks/useSettings";
import type { CharacterConfig } from "../../../../types";
import {
	AgentCard,
	type AgentProfile,
	FormGroup,
	FormSelect,
	SettingsSection,
} from "../SettingsComponents";

interface CharacterSettingsProps {
	profiles: Record<string, CharacterConfig>;
	activeProfileId: string;
	onUpdateProfile: (key: string, profile: CharacterConfig) => void;
	onSetActive: (key: string) => void;
	onAddProfile: (key: string) => void;
	onDeleteProfile: (key: string) => void;
}

interface EditState {
	key: string;
	profile: AgentProfile;
	model_config_name: string; // Restored feature
	isNew: boolean;
}

const CharacterSettings: React.FC<CharacterSettingsProps> = ({
	profiles,
	activeProfileId,
	onUpdateProfile,
	onSetActive,
	onAddProfile,
	onDeleteProfile,
}) => {
	const { t } = useTranslation();
	const { config: settingsConfig } = useSettings();

	// Model Options
	const modelOptions = settingsConfig?.models_gguf
		? Object.keys(settingsConfig.models_gguf).map((key) => ({
			value: key,
			label: key,
		}))
		: [];

	// Edit Modal State
	const [editState, setEditState] = useState<EditState | null>(null);
	const [newKeyInput, setNewKeyInput] = useState("");

	// Error message state
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Delete confirmation dialog state
	const [deleteConfirm, setDeleteConfirm] = useState<{
		key: string;
		isOpen: boolean;
	} | null>(null);

	// Clear error message after 4 seconds
	const showError = useCallback((message: string) => {
		setErrorMessage(message);
		setTimeout(() => setErrorMessage(null), 4000);
	}, []);

	// --- Converters ---

	const characterToAgentProfile = (config: CharacterConfig): AgentProfile => ({
		label: config.name,
		description: config.description,
		icon: config.icon,
		avatar_path: config.avatar_path,
		persona: {
			prompt: config.system_prompt,
		},
		tool_policy: {
			allow: [], // Characters don't have tools by default
			deny: [],
		},
	});

	// --- Handlers ---

	const handleEditCharacter = (key: string, config: CharacterConfig) => {
		setEditState({
			key,
			profile: characterToAgentProfile(config),
			model_config_name: config.model_config_name || "",
			isNew: false,
		});
	};

	const handleStartAdd = () => {
		setEditState({
			key: "",
			profile: {
				label: t("settings.sections.agents.default_name", "New Agent"),
				description: "",
				icon: "👤",
				avatar_path: "",
				persona: {
					prompt: t("settings.sections.agents.default_prompt", "You are a helpful assistant."),
				},
				tool_policy: {
					allow: [], // Characters don't have tools by default
					deny: [],
				},
			},
			model_config_name: "",
			isNew: true,
		});
		setNewKeyInput("");
	};

	const handleSaveEdit = () => {
		if (!editState) return;

		let targetKey = editState.key;

		if (editState.isNew) {
			// Validate key
			const key = newKeyInput
				.trim()
				.toLowerCase()
				.replace(/\s+/g, "_")
				.replace(/[^a-z0-9_]/g, "");
			if (!key) {
				showError(t("settings.sections.agents.error_empty_key"));
				return;
			}

			// Check duplicates
			const exists = profiles?.[key];

			if (exists) {
				showError(t("settings.sections.agents.error_duplicate_key"));
				return;
			}

			targetKey = key;
			onAddProfile(targetKey);
		}

		// Update config
		onUpdateProfile(targetKey, {
			name: editState.profile.label,
			description: editState.profile.description,
			system_prompt: editState.profile.persona.prompt || "",
			model_config_name: editState.model_config_name || undefined,
			icon: editState.profile.icon,
			avatar_path: editState.profile.avatar_path,
			// Characters ignore tools
		});

		setEditState(null);
	};

	const handleDelete = (key: string, e: React.MouseEvent) => {
		e.stopPropagation();
		if (key === activeProfileId) {
			showError(t("settings.sections.agents.cannot_delete_active"));
			return;
		}
		setDeleteConfirm({ key, isOpen: true });
	};

	const confirmDelete = () => {
		if (deleteConfirm) {
			onDeleteProfile(deleteConfirm.key);
			setDeleteConfirm(null);
		}
	};

	const cancelDelete = () => {
		setDeleteConfirm(null);
	};

	// --- Render Helpers ---

	const renderCard = (key: string, profile: AgentProfile) => {
		const isActive = activeProfileId === key;

		return (
			<div
				key={key}
				role="button"
				tabIndex={0}
				aria-pressed={isActive}
				className={`
					relative group flex flex-col p-4 rounded-xl border transition-all duration-200 cursor-pointer text-left w-full
					${isActive
						? "bg-gold-500/10 border-gold-500/50 shadow-[0_0_15px_rgba(255,215,0,0.1)]"
						: "bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10"
					}
					focus:outline-none focus:ring-2 focus:ring-gold-400/60 focus:ring-offset-2 focus:ring-offset-gray-950
				`}
				onClick={() => {
					onSetActive(key);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSetActive(key);
					}
				}}
			>
				{/* Active Indicator */}
				<div className="flex justify-between items-start mb-2">
					<div className="flex items-center gap-2">
						{profile.icon ? (
							<span className="text-lg">{profile.icon}</span>
						) : (
							<Users size={18} className={isActive ? "text-gold-400" : "text-gray-400"} />
						)}
						<h3 className={`font-medium ${isActive ? "text-gold-100" : "text-gray-200"}`}>
							{profile.label || key}
						</h3>
					</div>
					{isActive && <Check size={16} className="text-gold-400" />}
				</div>

				<p className="text-xs text-gray-500 font-mono mb-3 truncate">@{key}</p>

				<p className="text-sm text-gray-400 line-clamp-2 mb-4 h-10">
					{profile.description || t("settings.sections.agents.no_description")}
				</p>

				{/* Actions */}
				<div className="mt-auto flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							handleEditCharacter(key, profiles[key]);
						}}
						onKeyDown={(e) => e.stopPropagation()}
						className="p-1.5 hover:bg-white/10 rounded-md text-gray-400 hover:text-white transition-colors"
						title={t("settings.sections.agents.edit")}
					>
						<Edit2 size={14} />
					</button>
					{!isActive && (
						<button
							type="button"
							onClick={(e) => handleDelete(key, e)}
							onKeyDown={(e) => e.stopPropagation()}
							className="p-1.5 hover:bg-red-500/20 rounded-md text-gray-400 hover:text-red-400 transition-colors"
							title={t("settings.sections.agents.delete")}
						>
							<Trash2 size={14} />
						</button>
					)}
				</div>
			</div>
		);
	};

	const renderAddCard = () => (
		<button
			type="button"
			onClick={handleStartAdd}
			className="flex flex-col items-center justify-center p-4 rounded-xl border border-white/10 border-dashed bg-white/5 hover:bg-white/10 hover:border-white/30 transition-all gap-3 h-full min-h-[160px] group"
		>
			<div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-white/10 transition-colors">
				<Plus size={20} className="text-gray-400 group-hover:text-white" />
			</div>
			<span className="text-sm text-gray-400 group-hover:text-white font-medium">
				{t("settings.sections.agents.add_new_profile")}
			</span>
		</button>
	);

	return (
		<SettingsSection
			title={t("settings.sections.agents.title")}
			icon={<Users size={18} />}
			description={t("settings.sections.agents.description")}
		>
			{/* Tabs removed: Unified into separate sections */}
			{/* Content Area */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{/* Characters */}
				{profiles &&
					Object.entries(profiles).map(([key, config]) =>
						renderCard(key, characterToAgentProfile(config)),
					)}

				{renderAddCard()}
			</div>

			{/* Edit Modal with AgentCard */}
			<Modal
				isOpen={!!editState}
				onClose={() => setEditState(null)}
				title={
					editState?.isNew
						? t("settings.sections.agents.modal.title_add")
						: t("settings.sections.agents.modal.title_edit")
				}
				size="lg"
			>
				{editState && (
					<div className="space-y-4">
						{/* Key Input for New Agents */}
						{editState.isNew && (
							<div className="p-4 bg-white/5 rounded-xl border border-white/10 mb-4">
								<label
									htmlFor="agent-key-input"
									className="block text-sm font-medium text-gray-300 mb-1"
								>
									{t("settings.sections.agents.modal.key_label")}
								</label>
								<p className="text-xs text-gray-500 mb-2">
									{t("settings.sections.agents.modal.key_desc")}
								</p>
								<input
									id="agent-key-input"
									type="text"
									value={newKeyInput}
									onChange={(e) => setNewKeyInput(e.target.value)}
									placeholder="e.g. coding_expert"
									className="settings-input font-mono w-full"
								/>
							</div>
						)}

						{/* Model Selection (Restored) */}
						<div className="bg-white/5 p-4 rounded-xl border border-white/10">
							<FormGroup
								label={t("settings.sections.agents.modal.model_label")}
								description={t("settings.sections.agents.modal.model_desc")}
							>
								<FormSelect
									value={editState.model_config_name}
									onChange={(v) =>
										setEditState({
											...editState,
											model_config_name: v,
										})
									}
									options={[
										{
											value: "",
											label: t("settings.sections.models.defaults.global", "Global Default"),
										},
										...modelOptions,
									]}
								/>
							</FormGroup>
						</div>

						{/* The Restored AgentCard Component */}
						<AgentCard
							id={editState.key || newKeyInput || "new_agent"}
							profile={editState.profile}
							onChange={(p) => setEditState({ ...editState, profile: p })}
							isActive={activeProfileId === editState.key}
							onSetActive={() => {
								if (editState.key) {
									onSetActive(editState.key);
								}
							}}
						/>

						{/* Footer Actions */}
						<div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/10">
							<button
								type="button"
								onClick={() => setEditState(null)}
								className="px-4 py-2 rounded-md hover:bg-white/10 text-sm text-gray-300 transition-colors"
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={handleSaveEdit}
								className="px-4 py-2 rounded-md bg-gold-500 hover:bg-gold-600 text-black text-sm font-medium transition-colors"
							>
								{t("common.save")}
							</button>
						</div>
					</div>
				)}
			</Modal>

			{/* Delete Confirmation Dialog */}
			<ConfirmDialog
				isOpen={deleteConfirm?.isOpen || false}
				title={t("settings.sections.agents.delete_confirm_title", "Delete Profile")}
				message={t("settings.sections.agents.confirm_delete")}
				confirmLabel={t("common.delete", "Delete")}
				cancelLabel={t("common.cancel")}
				onConfirm={confirmDelete}
				onCancel={cancelDelete}
				variant="danger"
			/>

			{/* Error Toast */}
			{errorMessage && (
				<div className="fixed bottom-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg bg-red-900/90 border border-red-500/50 text-red-200 shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200">
					<AlertCircle size={18} className="text-red-400" />
					<span className="text-sm">{errorMessage}</span>
				</div>
			)}

			{/* Discreet NSFW Toggle */}
			<div className="mt-8 pt-6 border-t border-white/5 opacity-50 hover:opacity-100 transition-opacity">
				<div className="flex items-center justify-between">
					<span
						className="text-xs text-gray-500 cursor-help"
						title={t(
							"settings.sections.agents.nsfw_desc",
							"Allows generation of sensitive content. Use with caution.",
						)}
					>
						{t("settings.sections.agents.nsfw_label", "Unlock Restricted Content")}
					</span>
					<NsfwToggle />
				</div>
			</div>
		</SettingsSection>
	);
};

const NsfwToggle: React.FC = () => {
	const { config, updateApp } = useSettings();

	if (!config) return null;

	return (
		<label className="relative inline-flex items-center cursor-pointer">
			<input
				type="checkbox"
				className="sr-only peer"
				checked={config.app.nsfw_enabled}
				onChange={(e) => updateApp("nsfw_enabled", e.target.checked)}
			/>
			<div className="w-9 h-5 bg-gray-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-red-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-red-900"></div>
		</label>
	);
};

export default CharacterSettings;
