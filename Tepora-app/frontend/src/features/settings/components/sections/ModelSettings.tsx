import {
	Cpu,
	HardDrive,
	List,
	MessageSquare,
	Plus,
	RefreshCw,
	Settings2,
	Wrench,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
import { apiClient } from "../../../../utils/api-client";
import {
	CollapsibleSection,
	FormGroup,
	FormInput,
	FormSelect,
	SettingsSection,
} from "../SettingsComponents";
import { AddModelForm } from "../subcomponents/AddModelForm";
import { ModelListOverlay } from "../subcomponents/ModelListOverlay";
import { ModelSelectionRow } from "../subcomponents/ModelSelectionRow";

// Types
interface ModelConfig {
	path: string;
	port: number;
	n_ctx: number;
	n_gpu_layers: number;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	repeat_penalty?: number;
	logprobs?: boolean;
}

interface ModelInfo {
	id: string;
	display_name: string;
	role: string;
	file_size: number;
	filename?: string;
	source: string;
	is_active?: boolean;
}

interface ModelRoles {
	character_model_id: string | null;
	professional_model_map: Record<string, string>;
}

const ModelSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, originalConfig, updateLlmManager, updateModel } =
		useSettings();
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [isOverlayOpen, setIsOverlayOpen] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [modelRoles, setModelRoles] = useState<ModelRoles>({
		character_model_id: null,
		professional_model_map: {},
	});
	const [newTaskType, setNewTaskType] = useState("");

	// Fetch available models from backend
	const fetchModels = useCallback(async () => {
		try {
			const data = await apiClient.get<{ models?: ModelInfo[] }>(
				"api/setup/models",
			);
			setModels(data.models || []);
		} catch (e) {
			console.error("Failed to fetch models", e);
		}
	}, []);

	const fetchModelRoles = useCallback(async () => {
		try {
			const data = await apiClient.get<ModelRoles>("api/setup/model/roles");
			setModelRoles(data);
		} catch (e) {
			console.error("Failed to fetch model roles", e);
		}
	}, []);

	useEffect(() => {
		fetchModels();
		fetchModelRoles();
	}, [fetchModels, fetchModelRoles]);

	if (!config) return null;

	const llmConfig = config.llm_manager;
	const originalLlmConfig = originalConfig?.llm_manager;
	const modelsConfig = config.models_gguf;

	const isLlmDirty = (field: keyof typeof llmConfig) => {
		if (!originalLlmConfig) return false;
		return llmConfig[field] !== originalLlmConfig[field];
	};

	// Get default model configs for text and embedding
	const textModelConfig: ModelConfig = modelsConfig.text_model || {
		path: "",
		port: 8080,
		n_ctx: 4096,
		n_gpu_layers: -1,
		temperature: 0.7,
		top_p: 0.9,
	};

	const embeddingModelConfig: ModelConfig = modelsConfig.embedding_model || {
		path: "",
		port: 8081,
		n_ctx: 2048,
		n_gpu_layers: -1,
	};

	const handleSelectCharacterModel = async (modelId: string) => {
		try {
			await apiClient.post("api/setup/model/roles/character", {
				model_id: modelId,
			});
			await fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleSelectProfessionalModel = async (
		taskType: string,
		modelId: string,
	) => {
		try {
			await apiClient.post("api/setup/model/roles/professional", {
				task_type: taskType,
				model_id: modelId,
			});
			await fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleRemoveProfessionalMapping = async (taskType: string) => {
		try {
			await apiClient.delete(
				`api/setup/model/roles/professional/${encodeURIComponent(taskType)}`,
			);
			await fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleAddTaskType = async () => {
		if (!newTaskType.trim()) return;
		setModelRoles((prev) => ({
			...prev,
			professional_model_map: {
				...prev.professional_model_map,
				[newTaskType.trim()]: "",
			},
		}));
		setNewTaskType("");
	};

	const handleDelete = async (id: string) => {
		if (
			!confirm(
				t("settings.sections.models.confirm_delete") ||
					"Are you sure you want to delete this model?",
			)
		)
			return;
		try {
			await apiClient.delete(`api/setup/model/${id}`);
			fetchModels();
			fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleReorder = async (role: string, ids: string[]) => {
		try {
			await apiClient.post("api/setup/model/reorder", {
				role,
				model_ids: ids,
			});
			fetchModels();
		} catch (e) {
			console.error(e);
		}
	};

	const handleRefreshOllama = async () => {
		setIsRefreshing(true);
		try {
			await apiClient.post("api/setup/models/ollama/refresh");
			await fetchModels();
		} catch (e) {
			console.error("Failed to refresh Ollama models", e);
		} finally {
			setIsRefreshing(false);
		}
	};

	// Legacy: set pool active model for embedding only now
	const handleSelectEmbeddingModel = async (modelId: string) => {
		try {
			await apiClient.post("api/setup/model/active", {
				model_id: modelId,
				role: "embedding",
			});

			await fetchModels();
			const modelInList = models.find((m) => m.id === modelId);
			if (modelInList?.filename) {
				updateModel("embedding_model", {
					...embeddingModelConfig,
					path: `models/embedding/${modelInList.filename}`,
				});
			}
		} catch (e) {
			console.error(e);
		}
	};

	const textModels = models.filter((m) => m.role === "text");
	const embeddingModels = models.filter((m) => m.role === "embedding");
	const getActiveId = (role: string) =>
		models.find((m) => m.role === role && m.is_active)?.id;

	return (
		<div className="space-y-6">
			{/* 1. Model Management Section */}
			<SettingsSection
				title={
					t("settings.models_settings.download_manager.title") ||
					"Model Management"
				}
				icon={<HardDrive size={18} />}
				description={
					t("settings.models_settings.download_manager.description") ||
					"Manage your local model library."
				}
			>
				<div className="space-y-4">
					<AddModelForm onModelAdded={fetchModels} />

					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => setIsOverlayOpen(true)}
							className="flex-1 py-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center gap-2 hover:bg-white/10 transition-colors text-gray-300 hover:text-white"
						>
							<List size={18} />
							<span>
								{t("settings.sections.models.manage_models") || "Manage Models"}
							</span>
						</button>

						<button
							type="button"
							onClick={handleRefreshOllama}
							disabled={isRefreshing}
							className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center gap-2 hover:bg-white/10 transition-colors text-gray-300 hover:text-white disabled:opacity-50"
							title={
								t("settings.sections.models.refresh_ollama") ||
								"Refresh Ollama Models"
							}
						>
							<RefreshCw
								size={18}
								className={isRefreshing ? "animate-spin" : ""}
							/>
						</button>
					</div>
				</div>
			</SettingsSection>

			{/* 2. Character Model Selection */}
			<SettingsSection
				title={
					t("settings.sections.models.character_model_title") ||
					"Character Model"
				}
				icon={<MessageSquare size={18} />}
				description={
					t("settings.sections.models.character_model_desc") ||
					"Select the model used for conversation and persona-based responses."
				}
			>
				<ModelSelectionRow
					label={
						t("settings.sections.models.character_model_label") ||
						"Character Model"
					}
					selectedModelId={modelRoles.character_model_id || undefined}
					models={textModels}
					onSelect={handleSelectCharacterModel}
					config={textModelConfig}
					onUpdateConfig={(c) => updateModel("text_model", c)}
					modelRole="text"
				/>
			</SettingsSection>

			{/* 3. Professional Models Selection (Task Type based) */}
			<SettingsSection
				title={
					t("settings.sections.models.executor_models_title") ||
					"Professional Models"
				}
				icon={<Wrench size={18} />}
				description={
					t("settings.sections.models.executor_models_desc") ||
					"Configure models for different task types. Each task can use a specialized model."
				}
			>
				<div className="space-y-4">
					{Object.entries(modelRoles.professional_model_map).map(
						([taskType, modelId]) => (
							<ModelSelectionRow
								key={taskType}
								label={t("settings.sections.models.executor_label", {
									taskType,
								})}
								description={
									taskType === "default"
										? t("settings.sections.models.executor_default_desc")
										: t("settings.sections.models.executor_task_desc", {
												taskType,
											})
								}
								selectedModelId={modelId}
								models={textModels}
								onSelect={(id) => handleSelectProfessionalModel(taskType, id)}
								config={textModelConfig}
								onUpdateConfig={(c) => updateModel("text_model", c)}
								onDelete={
									taskType !== "default"
										? () => handleRemoveProfessionalMapping(taskType)
										: undefined
								}
								icon={<Wrench size={20} />}
								modelRole="text"
							/>
						),
					)}

					{/* Add new task type */}
					<div className="flex gap-2">
						<input
							type="text"
							value={newTaskType}
							onChange={(e) => setNewTaskType(e.target.value)}
							placeholder={
								t("settings.sections.models.add_task_placeholder") ||
								"Add task type (e.g., coding, browser)..."
							}
							className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-gold-400/50"
							onKeyDown={(e) => e.key === "Enter" && handleAddTaskType()}
						/>
						<button
							type="button"
							onClick={handleAddTaskType}
							disabled={!newTaskType.trim()}
							className="px-4 py-2.5 bg-gold-400/20 text-gold-400 rounded-xl hover:bg-gold-400/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
						>
							<Plus size={18} />
							<span>{t("common.add") || "Add"}</span>
						</button>
					</div>
				</div>
			</SettingsSection>

			{/* 4. Embedding Model Selection */}
			<SettingsSection
				title={
					t("settings.sections.models.embedding_model_title") ||
					"Embedding Model"
				}
				icon={<Cpu size={18} />}
				description={
					t("settings.sections.models.embedding_model_desc") ||
					"Select the model used for memory and retrieval."
				}
			>
				<ModelSelectionRow
					label=""
					selectedModelId={getActiveId("embedding")}
					models={embeddingModels}
					onSelect={handleSelectEmbeddingModel}
					config={embeddingModelConfig}
					onUpdateConfig={(c) => updateModel("embedding_model", c)}
					modelRole="embedding"
				/>
			</SettingsSection>

			{/* 5. Global LLM Manager Settings */}
			<SettingsSection
				title={
					t("settings.models_settings.global_manager.title") ||
					"LLM Manager Settings"
				}
				icon={<Settings2 size={18} />}
				description={
					t("settings.models_settings.global_manager.description") ||
					"Process management and health check settings."
				}
			>
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
					<FormGroup
						label={
							t("settings.models_settings.global_manager.terminate_timeout") ||
							"Terminate Timeout"
						}
						isDirty={isLlmDirty("process_terminate_timeout")}
					>
						<FormInput
							type="number"
							value={llmConfig.process_terminate_timeout}
							onChange={(v) =>
								updateLlmManager("process_terminate_timeout", v as number)
							}
							min={1}
						/>
					</FormGroup>
					<FormGroup
						label={
							t(
								"settings.models_settings.global_manager.health_check_timeout",
							) || "Health Check Timeout"
						}
						isDirty={isLlmDirty("health_check_timeout")}
					>
						<FormInput
							type="number"
							value={llmConfig.health_check_timeout}
							onChange={(v) =>
								updateLlmManager("health_check_timeout", v as number)
							}
							min={1}
						/>
					</FormGroup>
					<FormGroup
						label={
							t(
								"settings.models_settings.global_manager.health_check_interval",
							) || "Health Check Interval"
						}
						isDirty={isLlmDirty("health_check_interval")}
					>
						<FormInput
							type="number"
							value={llmConfig.health_check_interval}
							onChange={(v) =>
								updateLlmManager("health_check_interval", v as number)
							}
							step={0.1}
						/>
					</FormGroup>
					<FormGroup
						label={
							t("settings.models_settings.global_manager.tokenizer_model") ||
							"Tokenizer Model"
						}
						isDirty={isLlmDirty("tokenizer_model_key")}
					>
						<FormSelect
							value={llmConfig.tokenizer_model_key}
							onChange={(v) =>
								updateLlmManager("tokenizer_model_key", v as string)
							}
							options={[
								{ value: "text_model", label: "Text" },
								{ value: "embedding_model", label: "Embedding" },
							]}
						/>
					</FormGroup>
				</div>

				<CollapsibleSection
					title={
						t("settings.sections.models.advanced_title") ||
						"Advanced Manager Settings"
					}
					description={
						t("settings.sections.models.advanced_description") ||
						"Cache and resource settings"
					}
				>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						<FormGroup
							label={t("settings.fields.cache_size") || "Model Cache Limit"}
							description={
								t("settings.descriptions.cache_size") ||
								"Number of models to keep loaded in memory."
							}
							isDirty={isLlmDirty("cache_size")}
						>
							<FormInput
								type="number"
								value={llmConfig.cache_size ?? 1}
								onChange={(v) => updateLlmManager("cache_size", v as number)}
								min={1}
								max={5}
								step={1}
							/>
						</FormGroup>
					</div>
				</CollapsibleSection>
			</SettingsSection>

			<ModelListOverlay
				isOpen={isOverlayOpen}
				onClose={() => setIsOverlayOpen(false)}
				models={models}
				onDelete={handleDelete}
				onReorder={handleReorder}
			/>
		</div>
	);
};

export default ModelSettings;
