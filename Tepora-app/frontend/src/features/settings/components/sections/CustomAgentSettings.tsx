import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import { AlertCircle, Bot, Check, Plus, Settings2, Trash2, X, Smile } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import type { CustomAgentConfig, CustomAgentToolPolicy, ToolInfo } from "../../../../types";
import { ApiError, apiClient } from "../../../../utils/api-client";
import { logger } from "../../../../utils/logger";
import { FormGroup, SettingsSection } from "../SettingsComponents";
import { ModelSelector } from "../subcomponents/ModelSelector";
import { FitText } from "../../../../components/ui/FitText";

interface CustomAgentSettingsProps {
	agents: Record<string, CustomAgentConfig>;
	onUpdateAgent: (id: string, agent: CustomAgentConfig) => void;
	onAddAgent: (agent: CustomAgentConfig) => void;
	onDeleteAgent: (id: string) => void;
}

interface EditState {
	agent: CustomAgentConfig;
	isNew: boolean;
	originalId: string;
}

const DEFAULT_TOOL_POLICY: CustomAgentToolPolicy = {
	allow_all: true,
	allowed_tools: [],
	denied_tools: [],
	require_confirmation: [],
};

const CustomAgentSettings: React.FC<CustomAgentSettingsProps> = ({
	agents,
	onUpdateAgent,
	onAddAgent,
	onDeleteAgent,
}) => {
	const { t } = useTranslation();
	const [editState, setEditState] = useState<EditState | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{
		id: string;
		isOpen: boolean;
	} | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
	const [showEmojiPicker, setShowEmojiPicker] = useState(false);
	const emojiPickerRef = useRef<HTMLDivElement>(null);

	const showError = useCallback((message: string) => {
		setErrorMessage(message);
		setTimeout(() => setErrorMessage(null), 4000);
	}, []);

	useEffect(() => {
		const fetchTools = async () => {
			try {
				const data = await apiClient.get<{ tools?: ToolInfo[] }>("/api/tools");
				setAvailableTools(Array.isArray(data.tools) ? data.tools : []);
			} catch (error) {
				logger.error("Failed to fetch tools:", error);
				const errorDetails =
					error instanceof ApiError
						? error.message
						: error instanceof Error
							? error.message
							: "Unknown error";
				showError(`Failed to fetch tools: ${errorDetails}`);
			}
		};
		fetchTools();
	}, [showError]);

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

	const handleStartAdd = () => {
		const newAgent: CustomAgentConfig = {
			id: "",
			name: t("settings.sections.custom_agents.default_name", "New Agent"),
			description: "",
			icon: "🤖",
			system_prompt: t(
				"settings.sections.custom_agents.default_prompt",
				"You are a helpful assistant.",
			),
			tool_policy: { ...DEFAULT_TOOL_POLICY },
			tags: [],
			priority: 0,
			enabled: true,
		};
		setEditState({ agent: newAgent, isNew: true, originalId: "" });
		setShowEmojiPicker(false);
	};

	const handleEdit = (agent: CustomAgentConfig) => {
		setEditState({
			agent: { ...agent },
			isNew: false,
			originalId: agent.id
		});
		setShowEmojiPicker(false);
	};

	const handleSave = () => {
		if (!editState) return;

		const { agent, isNew, originalId } = editState;

		if (isNew && !agent.id.trim()) {
			showError(t("settings.sections.custom_agents.error_empty_id"));
			return;
		}
		if (!agent.name.trim()) {
			showError(t("settings.sections.custom_agents.error_empty_name"));
			return;
		}
		if (!agent.system_prompt.trim()) {
			showError(t("settings.sections.custom_agents.error_empty_prompt"));
			return;
		}

		if (isNew && agents[agent.id]) {
			showError(t("settings.sections.custom_agents.error_duplicate_id"));
			return;
		}

		if (isNew) {
			onAddAgent(agent);
		} else {
			if (agent.id !== originalId) {
				onUpdateAgent(originalId, agent);
			} else {
				onUpdateAgent(agent.id, agent);
			}
		}

		setEditState(null);
	};

	const handleDelete = (id: string, e: React.MouseEvent) => {
		e.stopPropagation();
		setDeleteConfirm({ id, isOpen: true });
	};

	const confirmDelete = () => {
		if (deleteConfirm) {
			if (editState?.originalId === deleteConfirm.id) {
				setEditState(null);
			}
			onDeleteAgent(deleteConfirm.id);
			setDeleteConfirm(null);
		}
	};

	const updateEditAgent = (updates: Partial<CustomAgentConfig>) => {
		if (!editState) return;
		setEditState({
			...editState,
			agent: { ...editState.agent, ...updates },
		});
	};

	const updateToolPolicy = (updates: Partial<CustomAgentToolPolicy>) => {
		if (!editState) return;
		setEditState({
			...editState,
			agent: {
				...editState.agent,
				tool_policy: { ...editState.agent.tool_policy, ...updates },
			},
		});
	};

	const toggleTool = (toolName: string) => {
		if (!editState) return;
		const policy = editState.agent.tool_policy;
		const isAllowAll = policy.allow_all;

		if (isAllowAll) {
			updateToolPolicy({
				allow_all: false,
				allowed_tools: availableTools.map((t) => t.name).filter((t) => t !== toolName),
			});
		} else {
			const isAllowed = policy.allowed_tools.includes(toolName);
			if (isAllowed) {
				updateToolPolicy({
					allowed_tools: policy.allowed_tools.filter((t) => t !== toolName),
				});
			} else {
				updateToolPolicy({
					allowed_tools: [...policy.allowed_tools, toolName],
				});
			}
		}
	};

	const isToolAllowed = (toolName: string): boolean => {
		if (!editState) return false;
		const policy = editState.agent.tool_policy;
		if (policy.allow_all) {
			return !policy.denied_tools.includes(toolName);
		}
		return policy.allowed_tools.includes(toolName);
	};

	const renderGridItem = (agent: CustomAgentConfig) => {
		return (
			<button
				type="button"
				key={agent.id}
				onClick={() => handleEdit(agent)}
				className={`
					flex flex-col p-4 rounded-xl border transition-all duration-200 group text-left bg-black/20 border-white/5 hover:bg-white/5 hover:border-white/10
					${agent.enabled ? "" : "opacity-60 grayscale-[0.5]"}
				`}
			>
				<div className="flex items-start justify-between w-full mb-3">
					<div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 bg-white/5">
						{agent.icon || "🤖"}
					</div>
					<div className="flex items-center gap-2">
						{agent.enabled && <span className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-green-400 bg-green-400/10 px-2 py-0.5 rounded-md"><Check size={12} /> Active</span>}
						<button
							type="button"
							onClick={(e) => handleDelete(agent.id, e)}
							className="p-1.5 hover:bg-red-500/20 rounded-md text-gray-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
							title={t("common.delete")}
						>
							<Trash2 size={14} />
						</button>
					</div>
				</div>
				<div className="min-w-0 w-full">
					<h4 className="text-base font-semibold truncate mb-1 text-white">
						{agent.name}
					</h4>
					<p className="text-xs text-gray-500 font-mono truncate mb-2">@{agent.id}</p>
					{agent.description && (
						<p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">{agent.description}</p>
					)}
				</div>
			</button>
		);
	};

	return (
		<SettingsSection
			title={t("settings.sections.custom_agents.title")}
			icon={<Bot size={18} />}
			description={t("settings.sections.custom_agents.description")}
		>
			<div className="space-y-4">
				<div className="flex justify-end">
					<button
						type="button"
						onClick={handleStartAdd}
						className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-medium text-white transition-colors"
					>
						<Plus size={16} />
						{t("settings.sections.custom_agents.add_new")}
					</button>
				</div>

				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
					{Object.values(agents).map(renderGridItem)}
				</div>
			</div>

			{/* Modal Overlay for Edit/Add */}
			{editState && createPortal(
				<div
					className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 p-4 sm:p-6"
					onClick={(e) => {
						if (e.target === e.currentTarget) setEditState(null);
					}}
				>
					<div className="bg-[#1a1a1a] w-[95vw] max-w-6xl h-[90vh] max-h-[900px] flex flex-col rounded-2xl shadow-2xl border border-white/10 animate-in zoom-in-95 duration-300 overflow-hidden">
						<div className="flex items-center justify-between p-6 border-b border-white/5 bg-white/[0.02] shrink-0">
							<h3 className="flex items-center gap-3 min-w-0 flex-1">
								<Bot size={22} className="text-tea-400" />
								<div className="min-w-0 h-7 flex items-center">
									<FitText className="text-xl font-medium text-white" minFontSize={14} maxFontSize={20}>
										{editState.isNew
											? t("settings.sections.custom_agents.modal.title_add")
											: t("settings.sections.custom_agents.modal.title_edit")}
									</FitText>
								</div>
							</h3>
							<button
								type="button"
								onClick={() => setEditState(null)}
								className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
							>
								<X size={22} />
							</button>
						</div>

						<div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-black/20">
							<div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-full">
								{/* Left Column */}
								<div className="lg:col-span-5 space-y-4 flex flex-col">
									{/* Basic Info */}
									<div className="bg-white/5 p-4 rounded-xl border border-white/10 space-y-4 flex-1">
										<div className="flex gap-4 items-start">
											{/* Icon / Profile Selection */}
											<div className="relative group shrink-0">
												<div className="w-20 h-20 rounded-full bg-black/40 border border-white/10 flex items-center justify-center text-3xl shadow-inner">
													<span>{editState.agent.icon || "🤖"}</span>
												</div>
												
												<div className="absolute -bottom-2 -right-2 flex gap-1">
													<div className="relative" ref={emojiPickerRef}>
														<button
															type="button"
															onClick={() => setShowEmojiPicker(!showEmojiPicker)}
															className="p-1.5 rounded-full bg-gray-800 hover:bg-gray-700 border border-white/10 text-tea-400 shadow-lg transition-colors"
															title="Choose Emoji"
														>
															<Smile size={14} />
														</button>
														{showEmojiPicker && (
															<div className="absolute bottom-full left-0 mb-2 z-50 shadow-2xl">
																<EmojiPicker 
																	theme={Theme.DARK} 
																	emojiStyle={EmojiStyle.NATIVE}
																	onEmojiClick={(emojiData) => {
																		updateEditAgent({ icon: emojiData.emoji });
																		setShowEmojiPicker(false);
																	}}
																/>
															</div>
														)}
													</div>
												</div>
											</div>

											{/* ID and Name */}
											<div className="flex-1 space-y-3">
												<FormGroup
													label={t("settings.sections.custom_agents.modal.id_label")}
												>
													<input
														type="text"
														value={editState.agent.id}
														disabled={!editState.isNew} // Disallow editing ID after creation
														onChange={(e) =>
															updateEditAgent({
																id: e.target.value
																	.toLowerCase()
																	.replace(/\s+/g, "_")
																	.replace(/[^a-z0-9_]/g, ""),
															})
														}
														placeholder="my_custom_agent"
														className={`settings-input font-mono w-full text-sm py-1.5 px-3 ${!editState.isNew ? "opacity-50 cursor-not-allowed" : ""}`}
													/>
												</FormGroup>

												<FormGroup label={t("settings.sections.custom_agents.modal.name_label")}>
													<input
														type="text"
														value={editState.agent.name}
														onChange={(e) => updateEditAgent({ name: e.target.value })}
														className="settings-input w-full text-sm py-1.5 px-3"
													/>
												</FormGroup>
											</div>
										</div>

										<div className="grid grid-cols-2 gap-3">
											<FormGroup label={t("settings.sections.custom_agents.modal.tags_label", "Tags")}>
												<input
													type="text"
													value={editState.agent.tags?.join(", ") || ""}
													onChange={(e) => updateEditAgent({ tags: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
													className="settings-input w-full text-sm py-1.5 px-3"
													placeholder="tag1, tag2"
												/>
											</FormGroup>
											<FormGroup label={t("settings.sections.custom_agents.modal.priority_label", "Priority")}>
												<input
													type="number"
													value={editState.agent.priority}
													onChange={(e) => updateEditAgent({ priority: parseInt(e.target.value) || 0 })}
													className="settings-input w-full text-sm py-1.5 px-3"
												/>
											</FormGroup>
										</div>

										<FormGroup label={t("settings.sections.custom_agents.modal.description_label")}>
											<textarea
												value={editState.agent.description}
												onChange={(e) => updateEditAgent({ description: e.target.value })}
												className="settings-input w-full h-24 resize-none text-sm py-1.5 px-3"
											/>
										</FormGroup>

										<FormGroup label={t("settings.sections.custom_agents.modal.model_label")}>
											<ModelSelector
												value={editState.agent.model_config_name}
												onChange={(v) =>
													updateEditAgent({
														model_config_name: v,
													})
												}
												role="text"
												placeholder={t("settings.sections.models.defaults.global", "Global Default")}
											/>
										</FormGroup>

										<FormGroup label={t("settings.sections.custom_agents.modal.enabled_label")}>
											<label className="relative inline-flex items-center cursor-pointer">
												<input
													type="checkbox"
													className="sr-only peer"
													checked={editState.agent.enabled}
													onChange={(e) => updateEditAgent({ enabled: e.target.checked })}
												/>
												<div className="w-9 h-5 bg-gray-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-tea-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-tea-600" />
											</label>
										</FormGroup>
									</div>
								</div>

								{/* Right Column */}
								<div className="lg:col-span-7 space-y-4 flex flex-col h-full">
									<div className="bg-white/5 p-4 rounded-xl border border-white/10 flex flex-col flex-1 min-h-[300px]">
										<div className="mb-2">
											<label className="block text-sm font-medium text-gray-200">
												{t("settings.sections.custom_agents.modal.prompt_label")}
											</label>
											<p className="text-xs text-gray-500 mt-1">
												{t("settings.sections.custom_agents.modal.prompt_desc")}
											</p>
										</div>
										<textarea
											value={editState.agent.system_prompt}
											onChange={(e) => updateEditAgent({ system_prompt: e.target.value })}
											className="settings-input w-full flex-1 resize-none font-mono text-sm leading-relaxed p-3"
										/>
									</div>

									<details className="bg-white/5 rounded-xl border border-white/10 group shrink-0">
										<summary className="p-4 flex items-center gap-2 cursor-pointer select-none">
											<Settings2 size={18} className="text-gray-400 group-open:text-tea-400 transition-colors" />
											<h4 className="text-sm font-medium text-gray-200 group-open:text-white transition-colors">
												{t("settings.sections.custom_agents.modal.tools_label")}
											</h4>
											<div className="ml-auto text-xs text-gray-500 group-open:hidden">
												{t("settings.sections.custom_agents.modal.click_to_expand", "Click to expand")}
											</div>
										</summary>
										
										<div className="p-4 pt-0 border-t border-white/10 mt-2">
											<div className="mb-4 mt-2">
												<label className="flex items-center gap-2 text-sm text-gray-300">
													<input
														type="checkbox"
														checked={editState.agent.tool_policy.allow_all || false}
														onChange={(e) => updateToolPolicy({ allow_all: e.target.checked })}
														className="rounded border-gray-600 text-tea-500 focus:ring-tea-500/20"
													/>
													{t("settings.sections.custom_agents.modal.allow_all_tools", "Allow All Tools (Blacklist mode)")}
												</label>
											</div>

											<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
												{availableTools.length === 0 ? (
													<p className="text-sm text-gray-500 italic col-span-2">
														{t("settings.sections.custom_agents.modal.no_tools")}
													</p>
												) : (
													availableTools.map((tool) => (
														<label
															key={tool.name}
															className="flex items-start gap-3 p-2.5 rounded-lg bg-black/20 hover:bg-white/5 border border-white/5 cursor-pointer transition-colors"
														>
															<input
																type="checkbox"
																checked={isToolAllowed(tool.name)}
																onChange={() => toggleTool(tool.name)}
																className="mt-1 rounded border-gray-600 text-tea-500 focus:ring-tea-500/20"
															/>
															<div className="flex-1 min-w-0">
																<span className="text-sm font-mono text-gray-200 block mb-0.5">{tool.name}</span>
																{tool.description && (
																	<p className="text-xs text-gray-500 truncate">{tool.description}</p>
																)}
															</div>
														</label>
													))
												)}
											</div>
										</div>
									</details>
								</div>
							</div>
						</div>

						<div className="p-6 border-t border-white/5 bg-white/[0.02] flex justify-end gap-3 rounded-b-2xl shrink-0">
							<button
								type="button"
								onClick={() => setEditState(null)}
								className="px-6 py-2.5 rounded-lg border border-white/10 text-gray-300 hover:text-white hover:bg-white/5 text-sm font-medium transition-colors"
							>
								{t("common.cancel", "Cancel")}
							</button>
							<button
								type="button"
								onClick={handleSave}
								className="px-6 py-2.5 rounded-lg bg-tea-500 hover:bg-tea-600 text-white text-sm font-bold transition-colors shadow-[0_0_15px_rgba(20,184,166,0.3)]"
							>
								{t("common.save", "Save")}
							</button>
						</div>
					</div>
				</div>,
				document.body
			)}

			<ConfirmDialog
				isOpen={deleteConfirm?.isOpen || false}
				title={t("settings.sections.custom_agents.delete_confirm_title")}
				message={t("settings.sections.custom_agents.confirm_delete")}
				confirmLabel={t("common.delete")}
				cancelLabel={t("common.cancel")}
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
		</SettingsSection>
	);
};

export default CustomAgentSettings;
