import { Check, Edit2, Plus, RefreshCw, Save, Trash2, User, X } from "lucide-react";
import type React from "react";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsContext } from "../../context/SettingsContext";
import type { CharacterConfig } from "../../types";

const PersonaSwitcher: React.FC = () => {
	const { t } = useTranslation();
	const settings = useContext(SettingsContext);

	// State for UI
	const [isOpen, setIsOpen] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [editingCharacter, setEditingCharacter] = useState<CharacterConfig | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (!settings || !settings.config) {
		return null; // Or a loading spinner
	}

	const { config, setActiveAgent, updateCharacter, addCharacter, deleteCharacter, saveConfig } =
		settings;

	const characters = config.characters || {};
	const currentPersonaId = config.active_agent_profile;

	const handleCreate = () => {
		setNewKey("");
		setError(null);
		setEditingCharacter({
			name: "",
			description: "",
			system_prompt: "",
			model_config_name: "default",
		});
		setIsCreating(true);
		setIsEditing(true);
		setIsOpen(false);
	};

	const handleEdit = (key: string, character: CharacterConfig, e: React.MouseEvent) => {
		e.stopPropagation();
		setEditingKey(key);
		setError(null);
		setEditingCharacter({ ...character });
		setIsCreating(false);
		setIsEditing(true);
		setIsOpen(false);
	};

	const handleDeleteRequest = (key: string, e: React.MouseEvent) => {
		e.stopPropagation();
		if (key === currentPersonaId) return;

		// Ensure at least one character remains
		if (Object.keys(characters).length <= 1) {
			// Silently ignore or maybe show a tooltip in future.
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
				console.error("Failed to save deletion");
			}
			setDeleteTarget(null);
		} catch (error) {
			console.error("Failed to delete character:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const handleSave = async () => {
		if (!editingCharacter || !editingCharacter.name) return;

		const key = isCreating ? newKey.trim().toLowerCase().replace(/\s+/g, "_") : editingKey;
		if (!key) return;

		setIsLoading(true);
		setError(null);
		try {
			if (isCreating) {
				// Ensure unique key
				if (characters[key]) {
					setError(t("personas.error_exists") || "This key already exists.");
					return;
				}
				addCharacter(key);
				updateCharacter(key, editingCharacter);
			} else if (editingKey) {
				updateCharacter(editingKey, editingCharacter);
			}

			const success = await saveConfig();
			if (success) {
				setIsEditing(false);
				setEditingCharacter(null);
				setEditingKey(null);
				setIsCreating(false);
				setNewKey("");
			}
		} catch (error) {
			console.error("Failed to save character:", error);
			setError("Failed to save character.");
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
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: handled by global key listener */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop close */}
						<div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
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
										className={`group w-full text-left flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all ${
											currentPersonaId === key ? "bg-white/10" : "hover:bg-white/5"
										}`}
									>
										<div className="flex items-center gap-3 overflow-hidden">
											<div
												className={`w-8 h-8 rounded-full flex items-center justify-center ${
													currentPersonaId === key
														? "bg-gold-500 text-black"
														: "bg-tea-800 text-tea-200"
												} shrink-0`}
											>
												<User size={14} />
											</div>
											<div className="min-w-0">
												<div
													className={`text-sm font-medium break-words ${
														currentPersonaId === key ? "text-gold-300" : "text-gray-200"
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
											>
												<Edit2 size={12} />
											</button>
											{/* Delete button: Only show if NOT active profile */}
											{key !== currentPersonaId && (
												<button
													type="button"
													onClick={(e) => handleDeleteRequest(key, e)}
													className="p-1 hover:text-red-400 text-gray-500 transition-colors"
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

			{/* Edit/Create Modal */}
			{isEditing && (
				<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
					<div className="glass-panel w-full max-w-lg p-6 space-y-4 animate-modal-enter">
						<div className="flex justify-between items-center mb-2">
							<h2 className="text-xl font-display text-gradient-tea">
								{isCreating ? t("personas.create_new") : t("personas.edit")}
							</h2>
							<button
								type="button"
								onClick={() => setIsEditing(false)}
								className="text-gray-400 hover:text-white"
							>
								<X size={20} />
							</button>
						</div>

						{error && (
							<div className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded-lg text-sm">
								{error}
							</div>
						)}

						<div className="space-y-4">
							{isCreating && (
								<div>
									<label
										htmlFor="input-key"
										className="text-xs text-gray-500 uppercase tracking-wider block mb-1"
									>
										ID (Key)
									</label>
									<input
										id="input-key"
										type="text"
										value={newKey}
										onChange={(e) => setNewKey(e.target.value)}
										className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-tea-100 focus:border-tea-500 focus:outline-none"
										placeholder="e.g. coding_assistant"
									/>
								</div>
							)}
							<div>
								<label
									htmlFor="input-name"
									className="text-xs text-gray-500 uppercase tracking-wider block mb-1"
								>
									{t("personas.name")}
								</label>
								<input
									id="input-name"
									type="text"
									value={editingCharacter?.name || ""}
									onChange={(e) =>
										setEditingCharacter((prev) => (prev ? { ...prev, name: e.target.value } : null))
									}
									className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-tea-100 focus:border-tea-500 focus:outline-none"
									placeholder="e.g. Coding Assistant"
								/>
							</div>

							<div>
								<label
									htmlFor="input-desc"
									className="text-xs text-gray-500 uppercase tracking-wider block mb-1"
								>
									{t("personas.description")}
								</label>
								<input
									id="input-desc"
									type="text"
									value={editingCharacter?.description || ""}
									onChange={(e) =>
										setEditingCharacter((prev) =>
											prev ? { ...prev, description: e.target.value } : null,
										)
									}
									className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-gray-300 focus:border-tea-500 focus:outline-none"
									placeholder="Brief description..."
								/>
							</div>

							<div>
								<label
									htmlFor="input-prompt"
									className="text-xs text-gray-500 uppercase tracking-wider block mb-1"
								>
									{t("personas.instruction")}
								</label>
								<textarea
									id="input-prompt"
									value={editingCharacter?.system_prompt || ""}
									onChange={(e) =>
										setEditingCharacter((prev) =>
											prev ? { ...prev, system_prompt: e.target.value } : null,
										)
									}
									className="w-full h-40 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-gray-300 focus:border-tea-500 focus:outline-none resize-none font-mono text-sm"
									placeholder="You are a helpful AI assistant..."
								/>
							</div>
						</div>

						<div className="flex justify-end gap-3 pt-4 border-t border-white/10">
							<button
								type="button"
								onClick={() => setIsEditing(false)}
								className="px-4 py-2 rounded-lg hover:bg-white/5 text-gray-400 text-sm transition-colors"
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={handleSave}
								disabled={isLoading || !editingCharacter?.name || (isCreating && !newKey.trim())}
								className="glass-button px-6 py-2 flex items-center gap-2 bg-tea-600/20 text-tea-300 hover:bg-tea-600/40 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{isLoading ? (
									<RefreshCw className="animate-spin w-4 h-4" />
								) : (
									<Save className="w-4 h-4" />
								)}
								{t("common.save")}
							</button>
						</div>
					</div>
				</div>
			)}

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
		</>
	);
};

export default PersonaSwitcher;
