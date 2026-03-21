import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import { Smile, Users, X, Image as ImageIcon } from "lucide-react";
import type React from "react";
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { type AgentProfile, FormGroup } from "../SettingsComponents";
import { ModelSelector } from "./ModelSelector";
import { FitText } from "../../../../components/ui/FitText";
import { logger } from "../../../../utils/logger";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface CharacterEditState {
	key: string;
	profile: AgentProfile;
	model_config_name: string;
	isNew: boolean;
}

interface CharacterEditOverlayProps {
	isOpen: boolean;
	editState: CharacterEditState | null;
	activeProfileId?: string; // Kept for interface compatibility but not strictly needed internally
	onClose: () => void;
	onSave: (targetKey: string, editState: CharacterEditState) => void;
	onSetActive?: (key: string) => void; // Kept for interface compatibility but not strictly needed internally
	existingKeys: string[];
	showError: (msg: string) => void;
}

export const CharacterEditOverlay: React.FC<CharacterEditOverlayProps> = ({
	isOpen,
	editState,
	onClose,
	onSave,
	existingKeys,
	showError,
}) => {
	const { t } = useTranslation();
	const [localState, setLocalState] = useState<CharacterEditState | null>(null);
	const [newKeyInput, setNewKeyInput] = useState("");
	const [showEmojiPicker, setShowEmojiPicker] = useState(false);
	const emojiPickerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (isOpen && editState) {
			setLocalState({ ...editState });
			setNewKeyInput(editState.isNew ? "" : editState.key);
		} else {
			setLocalState(null);
			setShowEmojiPicker(false);
		}
	}, [isOpen, editState]);

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
				setShowEmojiPicker(false);
			}
		};

		if (showEmojiPicker) {
			document.addEventListener("mousedown", handleClickOutside);
		}
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [showEmojiPicker]);

	if (!isOpen || !localState) return null;

	const handleSave = () => {
		let targetKey = localState.key;

		if (localState.isNew) {
			const key = newKeyInput
				.trim()
				.toLowerCase()
				.replace(/\s+/g, "_")
				.replace(/[^a-z0-9_]/g, "");
			if (!key) {
				showError(t("settings.sections.agents.error_empty_key", "Key cannot be empty"));
				return;
			}

			if (existingKeys.includes(key)) {
				showError(t("settings.sections.agents.error_duplicate_key", "Key already exists"));
				return;
			}
			targetKey = key;
		}

		onSave(targetKey, localState);
	};

	const handleBrowseAvatar = async () => {
		try {
			const selected = await open({
				multiple: false,
				filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
			});
			if (selected && typeof selected === "string") {
				setLocalState({
					...localState,
					profile: {
						...localState.profile,
						avatar_path: selected,
						icon: "", // Clear emoji if image is selected
					}
				});
			}
		} catch (e) {
			logger.error("Failed to open file dialog", e);
		}
	};

	const updateProfileField = <K extends keyof AgentProfile>(field: K, value: AgentProfile[K]) => {
		setLocalState({
			...localState,
			profile: {
				...localState.profile,
				[field]: value
			}
		});
	};

	const avatarSrc = localState.profile.avatar_path ? convertFileSrc(localState.profile.avatar_path) : null;

	return createPortal(
		<div
			className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 p-4 sm:p-6"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="bg-[#1a1a1a] w-[95vw] max-w-6xl h-[90vh] max-h-[900px] flex flex-col rounded-2xl shadow-2xl border border-white/10 animate-in zoom-in-95 duration-300 overflow-hidden">
				<div className="flex items-center justify-between p-6 border-b border-white/5 bg-white/[0.02] shrink-0">
					<h3 className="flex items-center gap-3 min-w-0 flex-1">
						<Users size={22} className="text-gold-400" />
						<div className="min-w-0 h-7 flex items-center">
							<FitText className="text-xl font-medium text-white" minFontSize={14} maxFontSize={20}>
								{localState.isNew ? t("settings.sections.agents.modal.title_add", "Add Character") : t("settings.sections.agents.modal.title_edit", "Edit Character")}
							</FitText>
						</div>
					</h3>
					<button
						type="button"
						onClick={onClose}
						className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
					>
						<X size={22} />
					</button>
				</div>

				<div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-black/20">
					<div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-full">
						{/* Left Column */}
						<div className="lg:col-span-5 space-y-4 flex flex-col">
							{/* Basic Info: Icon + Name + ID */}
							<div className="bg-white/5 p-4 rounded-xl border border-white/10 flex flex-col gap-4">
								<div className="flex gap-4 items-start">
									{/* Icon / Avatar Selection */}
									<div className="relative group shrink-0">
										<div className="w-20 h-20 rounded-full bg-black/40 border border-white/10 flex items-center justify-center text-3xl overflow-hidden shadow-inner">
											{avatarSrc ? (
												<img src={avatarSrc} alt="Avatar" className="w-full h-full object-cover" />
											) : (
												<span>{localState.profile.icon || "👤"}</span>
											)}
										</div>
										
										<div className="absolute -bottom-2 -right-2 flex gap-1">
											<div className="relative" ref={emojiPickerRef}>
												<button
													type="button"
													onClick={() => setShowEmojiPicker(!showEmojiPicker)}
													className="p-1.5 rounded-full bg-gray-800 hover:bg-gray-700 border border-white/10 text-gold-400 shadow-lg transition-colors"
													title={t("settings.character_edit.choose_emoji", "Choose Emoji")}
												>
													<Smile size={14} />
												</button>
												{showEmojiPicker && (
													<div className="absolute bottom-full left-0 mb-2 z-50 shadow-2xl">
														<EmojiPicker 
															theme={Theme.DARK} 
															emojiStyle={EmojiStyle.NATIVE}
															onEmojiClick={(emojiData) => {
																setLocalState({
																	...localState,
																	profile: {
																		...localState.profile,
																		icon: emojiData.emoji,
																		avatar_path: "",
																	}
																});
																setShowEmojiPicker(false);
															}}
														/>
													</div>
												)}
											</div>
											<button
												type="button"
												onClick={handleBrowseAvatar}
												className="p-1.5 rounded-full bg-gray-800 hover:bg-gray-700 border border-white/10 text-blue-400 shadow-lg transition-colors"
												title={t("settings.character_edit.upload_image", "Upload Image")}
											>
												<ImageIcon size={14} />
											</button>
											{(localState.profile.icon || localState.profile.avatar_path) && (
												<button
													type="button"
													onClick={() => {
														setLocalState({
															...localState,
															profile: {
																...localState.profile,
																icon: "",
																avatar_path: "",
															}
														});
													}}
													className="p-1.5 rounded-full bg-gray-800 hover:bg-gray-700 border border-white/10 text-red-400 shadow-lg transition-colors"
													title={t("settings.character_edit.clear_avatar", "Clear")}
												>
													<X size={14} />
												</button>
											)}
										</div>
									</div>

									{/* Name and ID */}
									<div className="flex-1 space-y-3">
										{localState.isNew && (
											<FormGroup label={t("settings.sections.agents.modal.key_label", "Character ID")}>
												<input
													id="agent-key-input"
													type="text"
													value={newKeyInput}
													onChange={(e) => setNewKeyInput(e.target.value)}
													placeholder={t("settings.sections.agents.modal.key_placeholder", "e.g. coding_expert")}
													className="settings-input font-mono w-full text-sm py-1.5 px-3"
												/>
											</FormGroup>
										)}
										<FormGroup label={t("settings.sections.agents.card.label", "Name")}>
											<input
												type="text"
												value={localState.profile.label}
												onChange={(e) => updateProfileField("label", e.target.value)}
												placeholder={t("settings.sections.agents.card.label_placeholder", "e.g. Coding Assistant")}
												className="settings-input w-full text-sm py-1.5 px-3"
											/>
										</FormGroup>
									</div>
								</div>

								<FormGroup label={t("settings.sections.agents.card.description", "Description")}>
									<textarea
										value={localState.profile.description}
										onChange={(e) => updateProfileField("description", e.target.value)}
										placeholder={t("settings.sections.agents.card.description_placeholder", "Brief description...")}
										className="settings-input w-full h-24 resize-none text-sm py-1.5 px-3"
									/>
								</FormGroup>
							</div>

							<div className="bg-white/5 p-4 rounded-xl border border-white/10 shrink-0">
								<FormGroup
									label={t("settings.sections.agents.modal.model_label", "Default Model")}
									description={t("settings.sections.agents.modal.model_desc", "Model used when this character is active.")}
								>
									<ModelSelector
										value={localState.model_config_name}
										onChange={(v) =>
											setLocalState({
												...localState,
												model_config_name: v,
											})
										}
										role="text"
										placeholder={t("settings.sections.models.defaults.global", "Global Default")}
									/>
								</FormGroup>
							</div>
						</div>

						{/* Right Column */}
						<div className="lg:col-span-7 space-y-4 flex flex-col h-full">
							<div className="bg-white/5 p-4 rounded-xl border border-white/10 flex flex-col flex-1 min-h-[300px]">
								<div className="mb-2">
									<label className="block text-sm font-medium text-gray-200">
										{t("settings.sections.agents.card.system_prompt", "System Prompt")}
									</label>
									<p className="text-xs text-gray-500 mt-1">
										{t("settings.sections.agents.card.persona_description", "Define the character's behavior and personality.")}
									</p>
								</div>
								<textarea
									value={localState.profile.character.prompt || ""}
									onChange={(e) => setLocalState({
										...localState,
										profile: {
											...localState.profile,
											persona: {
												...localState.profile.persona,
												prompt: e.target.value
											}
										}
									})}
									className="settings-input w-full flex-1 resize-none font-mono text-sm leading-relaxed p-3"
									placeholder={t("settings.sections.agents.card.custom_prompt_placeholder", "You are a helpful assistant...")}
								/>
							</div>
						</div>
					</div>
				</div>

				<div className="p-6 border-t border-white/5 bg-white/[0.02] flex justify-end gap-3 rounded-b-2xl shrink-0">
					<button
						type="button"
						onClick={onClose}
						className="px-6 py-2.5 rounded-lg border border-white/10 text-gray-300 hover:text-white hover:bg-white/5 text-sm font-medium transition-colors"
					>
						{t("common.cancel", "Cancel")}
					</button>
					<button
						type="button"
						onClick={handleSave}
						className="px-6 py-2.5 rounded-lg bg-gold-500 hover:bg-gold-600 text-black text-sm font-bold transition-colors shadow-[0_0_15px_rgba(251,191,36,0.3)]"
					>
						{t("common.save", "Save")}
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
};
