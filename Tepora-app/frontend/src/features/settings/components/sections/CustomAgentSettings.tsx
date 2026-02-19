import { AlertCircle, Bot, Check, Edit2, Plus, Settings2, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import Modal from "../../../../components/ui/Modal";
import { useSettings } from "../../../../hooks/useSettings";
import type { CustomAgentConfig, CustomAgentToolPolicy, ToolInfo } from "../../../../types";
import { ApiError, apiClient } from "../../../../utils/api-client";
import { FormGroup, SettingsSection } from "../SettingsComponents";

interface CustomAgentSettingsProps {
	agents: Record<string, CustomAgentConfig>;
	onUpdateAgent: (id: string, agent: CustomAgentConfig) => void;
	onAddAgent: (agent: CustomAgentConfig) => void;
	onDeleteAgent: (id: string) => void;
}

interface EditState {
	agent: CustomAgentConfig;
	isNew: boolean;
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
	const { config: settingsConfig } = useSettings();
	const [editState, setEditState] = useState<EditState | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{
		id: string;
		isOpen: boolean;
	} | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);

	const showError = useCallback((message: string) => {
		setErrorMessage(message);
		setTimeout(() => setErrorMessage(null), 4000);
	}, []);

	// Model options from config
	const modelOptions = settingsConfig?.models_gguf
		? Object.keys(settingsConfig.models_gguf).map((key) => ({
			value: key,
			label: key,
		}))
		: [];

	// Fetch available tools
	useEffect(() => {
		const fetchTools = async () => {
			try {
				const data = await apiClient.get<{ tools?: ToolInfo[] }>("/api/tools");
				setAvailableTools(Array.isArray(data.tools) ? data.tools : []);
			} catch (error) {
				console.error("Failed to fetch tools:", error);
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
		setEditState({ agent: newAgent, isNew: true });
	};

	const handleEdit = (agent: CustomAgentConfig) => {
		setEditState({
			agent: { ...agent },
			isNew: false,
		});
	};

	const handleSave = () => {
		if (!editState) return;

		const { agent, isNew } = editState;

		// Validate
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

		// Check for duplicate ID
		if (isNew && agents[agent.id]) {
			showError(t("settings.sections.custom_agents.error_duplicate_id"));
			return;
		}

		if (isNew) {
			onAddAgent(agent);
		} else {
			onUpdateAgent(agent.id, agent);
		}

		setEditState(null);
	};

	const handleDelete = (id: string, e: React.MouseEvent) => {
		e.stopPropagation();
		setDeleteConfirm({ id, isOpen: true });
	};

	const confirmDelete = () => {
		if (deleteConfirm) {
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
			// Switch to explicit list: allow all except the one being toggled (which effectively denies it if we switch to allow_all=false)
			// Wait, logic: if currently Allow All, toggling a tool means "Deny this tool" or "Switch to Allow List mode"?
			// V4 backend logic:
			// allow_all: true -> allowed_tools is ignored? No, backend implementation:
			// let allow_all = self.allow_all.unwrap_or(self.allowed_tools.is_empty());
			// If allow_all is true, we check denied_tools.
			// If allow_all is false, we check allowed_tools.

			// Simplified UI logic:
			// We present a list of checkboxes.
			// If Allow All is checked, checkboxes are disabled or hidden?
			// Or:
			// Checkbox checked = Allowed. Unchecked = Denied.
			// If user checks ALL tools -> allow_all = true?
			// This is tricky mapping.

			// Let's stick to explicit allowed list for UI simplicity if possible, OR implement a specific "Allow All Tools" checkbox.
			// For now, let's just toggle inclusion in `allowed_tools` and set `allow_all` to false if any manipulation happens.

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

	const renderAgentCard = (agent: CustomAgentConfig) => (
		// biome-ignore lint/a11y/useSemanticElements: contains nested interactive buttons
		<button
			type="button"
			key={agent.id}
			className={`
				relative group flex flex-col p-4 rounded-xl border transition-all duration-200 cursor-pointer text-left w-full
				${agent.enabled
					? "bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10"
					: "bg-white/3 border-white/5 opacity-60"
				}
			`}
			onClick={() => handleEdit(agent)}
		>
			<div className="flex justify-between items-start mb-2">
				<div className="flex items-center gap-2">
					<span className="text-2xl">{agent.icon || "🤖"}</span>
					<h3 className="font-medium text-gray-200">{agent.name}</h3>
				</div>
				{agent.enabled && <Check size={16} className="text-green-400" />}
			</div>

			<p className="text-xs text-gray-500 font-mono mb-2">@{agent.id}</p>

			<p className="text-sm text-gray-400 line-clamp-2 mb-4 h-10">
				{agent.description || t("settings.sections.custom_agents.no_description")}
			</p>

			<div className="mt-auto flex justify-between items-center opacity-0 group-hover:opacity-100 transition-opacity">
				<div className="flex gap-1">
					{agent.tags?.slice(0, 2).map(tag => (
						<span key={tag} className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-gray-400">
							{tag}
						</span>
					))}
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							handleEdit(agent);
						}}
						onKeyDown={(e) => e.stopPropagation()}
						className="p-1.5 hover:bg-white/10 rounded-md text-gray-400 hover:text-white transition-colors"
						title={t("common.edit")}
					>
						<Edit2 size={14} />
					</button>
					<button
						type="button"
						onClick={(e) => handleDelete(agent.id, e)}
						onKeyDown={(e) => e.stopPropagation()}
						className="p-1.5 hover:bg-red-500/20 rounded-md text-gray-400 hover:text-red-400 transition-colors"
						title={t("common.delete")}
					>
						<Trash2 size={14} />
					</button>
				</div>
			</div>
		</button>
	);

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
				{t("settings.sections.custom_agents.add_new")}
			</span>
		</button>
	);

	return (
		<SettingsSection
			title={t("settings.sections.custom_agents.title")}
			icon={<Bot size={18} />}
			description={t("settings.sections.custom_agents.description")}
		>
			{/* Agent Grid */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{Object.values(agents).map(renderAgentCard)}
				{renderAddCard()}
			</div>

			{/* Edit Modal */}
			<Modal
				isOpen={!!editState}
				onClose={() => setEditState(null)}
				title={
					editState?.isNew
						? t("settings.sections.custom_agents.modal.title_add")
						: t("settings.sections.custom_agents.modal.title_edit")
				}
				size="lg"
			>
				{editState && (
					<div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
						{/* Basic Info */}
						<div className="bg-white/5 p-4 rounded-xl border border-white/10 space-y-3">
							{editState.isNew && (
								<FormGroup
									label={t("settings.sections.custom_agents.modal.id_label")}
									description={t("settings.sections.custom_agents.modal.id_desc")}
								>
									<input
										type="text"
										value={editState.agent.id}
										onChange={(e) =>
											updateEditAgent({
												id: e.target.value
													.toLowerCase()
													.replace(/\s+/g, "_")
													.replace(/[^a-z0-9_]/g, ""),
											})
										}
										placeholder="my_custom_agent"
										className="settings-input font-mono w-full"
									/>
								</FormGroup>
							)}

							<div className="grid grid-cols-[auto_1fr] gap-3">
								<FormGroup label={t("settings.sections.custom_agents.modal.icon_label")}>
									<input
										type="text"
										value={editState.agent.icon || ""}
										onChange={(e) => updateEditAgent({ icon: e.target.value })}
										className="settings-input w-24 text-center text-xl"
										placeholder="🤖"
									/>
								</FormGroup>
								<FormGroup label={t("settings.sections.custom_agents.modal.name_label")}>
									<input
										type="text"
										value={editState.agent.name}
										onChange={(e) => updateEditAgent({ name: e.target.value })}
										className="settings-input w-full"
									/>
								</FormGroup>
							</div>

							<div className="grid grid-cols-2 gap-3">
								<FormGroup label={t("settings.sections.custom_agents.modal.tags_label", "Tags")}>
									<input
										type="text"
										value={editState.agent.tags?.join(", ") || ""}
										onChange={(e) => updateEditAgent({ tags: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
										className="settings-input w-full"
										placeholder="tag1, tag2"
									/>
								</FormGroup>
								<FormGroup label={t("settings.sections.custom_agents.modal.priority_label", "Priority")}>
									<input
										type="number"
										value={editState.agent.priority}
										onChange={(e) => updateEditAgent({ priority: parseInt(e.target.value) || 0 })}
										className="settings-input w-full"
									/>
								</FormGroup>
							</div>

							<FormGroup label={t("settings.sections.custom_agents.modal.description_label")}>
								<textarea
									value={editState.agent.description}
									onChange={(e) => updateEditAgent({ description: e.target.value })}
									className="settings-input w-full h-16 resize-none"
								/>
							</FormGroup>

							<FormGroup label={t("settings.sections.custom_agents.modal.model_label")}>
								<select
									value={editState.agent.model_config_name || ""}
									onChange={(e) =>
										updateEditAgent({
											model_config_name: e.target.value || undefined,
										})
									}
									className="settings-input w-full"
								>
									<option value="">{t("settings.sections.models.defaults.global")}</option>
									{modelOptions.map((opt) => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</select>
							</FormGroup>

							<FormGroup label={t("settings.sections.custom_agents.modal.enabled_label")}>
								<label className="relative inline-flex items-center cursor-pointer">
									<input
										type="checkbox"
										className="sr-only peer"
										checked={editState.agent.enabled}
										onChange={(e) => updateEditAgent({ enabled: e.target.checked })}
									/>
									<div className="w-11 h-6 bg-gray-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-tea-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-tea-600" />
								</label>
							</FormGroup>
						</div>

						{/* System Prompt */}
						<div className="bg-white/5 p-4 rounded-xl border border-white/10">
							<FormGroup
								label={t("settings.sections.custom_agents.modal.prompt_label")}
								description={t("settings.sections.custom_agents.modal.prompt_desc")}
							>
								<textarea
									value={editState.agent.system_prompt}
									onChange={(e) => updateEditAgent({ system_prompt: e.target.value })}
									className="settings-input w-full h-40 resize-none font-mono text-sm"
								/>
							</FormGroup>
						</div>

						{/* Tool Policy */}
						<div className="bg-white/5 p-4 rounded-xl border border-white/10">
							<div className="flex items-center gap-2 mb-3">
								<Settings2 size={16} className="text-gray-400" />
								<h4 className="text-sm font-medium text-gray-200">
									{t("settings.sections.custom_agents.modal.tools_label")}
								</h4>
							</div>

							<div className="mb-3">
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

							<div className="space-y-2 max-h-48 overflow-y-auto">
								{availableTools.length === 0 ? (
									<p className="text-sm text-gray-500 italic">
										{t("settings.sections.custom_agents.modal.no_tools")}
									</p>
								) : (
									availableTools.map((tool) => (
										<label
											key={tool.name}
											className="flex items-start gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer"
										>
											<input
												type="checkbox"
												checked={isToolAllowed(tool.name)}
												onChange={() => toggleTool(tool.name)}
												className="mt-1 rounded border-gray-600 text-tea-500 focus:ring-tea-500/20"
											/>
											<div className="flex-1 min-w-0">
												<span className="text-sm font-mono text-gray-200">{tool.name}</span>
												{tool.description && (
													<p className="text-xs text-gray-500 truncate">{tool.description}</p>
												)}
											</div>
										</label>
									))
								)}
							</div>
						</div>

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
								onClick={handleSave}
								className="px-4 py-2 rounded-md bg-tea-500 hover:bg-tea-600 text-white text-sm font-medium transition-colors"
							>
								{t("common.save")}
							</button>
						</div>
					</div>
				)}
			</Modal>

			{/* Delete Confirmation */}
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

			{/* Error Toast */}
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
