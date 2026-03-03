import { AlertCircle, Check, Plus, Trash2, Users, User } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import { useSettings } from "../../../../hooks/useSettings";
import type { CharacterConfig } from "../../../../types";
import {
	type AgentProfile,
	SettingsSection,
} from "../SettingsComponents";
import { CharacterEditOverlay, type CharacterEditState } from "../subcomponents/CharacterEditOverlay";

interface CharacterSettingsProps {
	profiles: Record<string, CharacterConfig>;
	activeProfileId: string;
	onUpdateProfile: (key: string, profile: CharacterConfig) => void;
	onSetActive?: (key: string) => void; // Keep for interface compatibility but optional
	onAddProfile: (key: string) => void;
	onDeleteProfile: (key: string) => void;
}

const CharacterSettings: React.FC<CharacterSettingsProps> = ({
	profiles,
	activeProfileId,
	onUpdateProfile,
	onAddProfile,
	onDeleteProfile,
}) => {
	const { t } = useTranslation();

	const [editState, setEditState] = useState<CharacterEditState | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{
		key: string;
		isOpen: boolean;
	} | null>(null);

	const showError = useCallback((message: string) => {
		setErrorMessage(message);
		setTimeout(() => setErrorMessage(null), 4000);
	}, []);

	const characterToAgentProfile = (config: CharacterConfig): AgentProfile => ({
		label: config.name,
		description: config.description,
		icon: config.icon,
		avatar_path: config.avatar_path,
		persona: {
			prompt: config.system_prompt,
		},
		tool_policy: {
			allow: [],
			deny: [],
		},
	});

	const handleSelectCharacter = (key: string, config: CharacterConfig) => {
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
	};

	const handleSaveEdit = (targetKey: string, savedState: CharacterEditState) => {
		if (savedState.isNew) {
			onAddProfile(targetKey);
		}

		onUpdateProfile(targetKey, {
			name: savedState.profile.label,
			description: savedState.profile.description,
			system_prompt: savedState.profile.persona.prompt || "",
			model_config_name: savedState.model_config_name || undefined,
			icon: savedState.profile.icon,
			avatar_path: savedState.profile.avatar_path,
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
			if (editState?.key === deleteConfirm.key) {
				setEditState(null);
			}
			onDeleteProfile(deleteConfirm.key);
			setDeleteConfirm(null);
		}
	};

	const renderGridItem = (key: string, config: CharacterConfig) => {
		const isActive = activeProfileId === key;

		return (
			<button
				key={key}
				type="button"
				onClick={() => handleSelectCharacter(key, config)}
				className={`
					flex flex-col p-4 rounded-xl border transition-all duration-200 group text-left
					${isActive ? "bg-gold-500/10 border-gold-500/30 shadow-[0_0_15px_rgba(251,191,36,0.1)]" : "bg-black/20 border-white/5 hover:bg-white/5 hover:border-white/10"}
				`}
			>
				<div className="flex items-start justify-between w-full mb-3">
					<div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 ${isActive ? "bg-gold-500/20" : "bg-white/5"}`}>
						{config.icon || <User size={20} className={isActive ? "text-gold-400" : "text-gray-400"} />}
					</div>
					<div className="flex items-center gap-2">
						{isActive && <span className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-gold-400 bg-gold-400/10 px-2 py-0.5 rounded-md"><Check size={12} /> Active</span>}
						{!isActive && (
							<button
								type="button"
								onClick={(e) => handleDelete(key, e)}
								className="p-1.5 hover:bg-red-500/20 rounded-md text-gray-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
								title={t("common.delete")}
							>
								<Trash2 size={14} />
							</button>
						)}
					</div>
				</div>
				<div className="min-w-0 w-full">
					<h4 className={`text-base font-semibold truncate mb-1 ${isActive ? "text-gold-200" : "text-white"}`}>
						{config.name || key}
					</h4>
					<p className="text-xs text-gray-500 font-mono truncate mb-2">@{key}</p>
					{config.description && (
						<p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">{config.description}</p>
					)}
				</div>
			</button>
		);
	};

	return (
		<SettingsSection
			title={t("settings.sections.agents.title")}
			icon={<Users size={18} />}
			description={t("settings.sections.agents.description")}
		>
			<div className="space-y-4">
				<div className="flex justify-end">
					<button
						type="button"
						onClick={handleStartAdd}
						className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-medium text-white transition-colors"
					>
						<Plus size={16} />
						{t("settings.sections.agents.add_new_profile")}
					</button>
				</div>

				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
					{profiles && Object.entries(profiles).map(([key, config]) => renderGridItem(key, config))}
				</div>
			</div>

			<CharacterEditOverlay
				isOpen={!!editState}
				editState={editState}
				onClose={() => setEditState(null)}
				onSave={handleSaveEdit}
				existingKeys={Object.keys(profiles || {})}
				showError={showError}
			/>

			<ConfirmDialog
				isOpen={deleteConfirm?.isOpen || false}
				title={t("settings.sections.agents.delete_confirm_title", "Delete Profile")}
				message={t("settings.sections.agents.confirm_delete", "Delete this profile?")}
				confirmLabel={t("common.delete", "Delete")}
				cancelLabel={t("common.cancel", "Cancel")}
				onConfirm={confirmDelete}
				onCancel={() => setDeleteConfirm(null)}
				variant="danger"
			/>

			{errorMessage && (
				<div className="fixed bottom-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg bg-red-900/90 border border-red-500/50 text-red-200 shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200">
					<AlertCircle size={18} className="text-red-400" />
					<span className="text-sm">{errorMessage}</span>
				</div>
			)}

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
