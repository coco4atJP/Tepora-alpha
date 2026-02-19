import { Cpu, Database, HardDrive, List, MessageSquare, Plus, RefreshCw, Shield, Wrench } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
import { apiClient } from "../../../../utils/api-client";
import { loadersApi } from "../../../../api/loaders";
import { FormGroup, FormInput, FormList, FormSwitch, SettingsSection } from "../SettingsComponents";
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
	loader?: string;
	is_active?: boolean;
}

interface ModelRoles {
	character_model_id: string | null;
	professional_model_map: Record<string, string>;
}

const ModelSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, originalConfig, updateLlmManager, updateModel, updateSearch, updateModelDownload, updateLoaderBaseUrl } = useSettings();
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [isOverlayOpen, setIsOverlayOpen] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isRefreshingLmStudio, setIsRefreshingLmStudio] = useState(false);
	const [modelRoles, setModelRoles] = useState<ModelRoles>({
		character_model_id: null,
		professional_model_map: {},
	});
	const [newTaskType, setNewTaskType] = useState("");

	// Fetch available models from backend
	const fetchModels = useCallback(async () => {
		try {
			const data = await apiClient.get<{ models?: ModelInfo[] }>("api/setup/models");
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
	const modelsConfig = config.models_gguf || {};

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

	const handleSelectProfessionalModel = async (taskType: string, modelId: string) => {
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
			await apiClient.delete(`api/setup/model/roles/professional/${encodeURIComponent(taskType)}`);
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
			await loadersApi.refreshOllamaModels();
			await fetchModels();
		} catch (e) {
			console.error("Failed to refresh Ollama models", e);
		} finally {
			setIsRefreshing(false);
		}
	};

	const handleRefreshLmStudio = async () => {
		setIsRefreshingLmStudio(true);
		try {
			await loadersApi.refreshLmStudioModels();
			await fetchModels();
		} catch (e) {
			console.error("Failed to refresh LM Studio models", e);
		} finally {
			setIsRefreshingLmStudio(false);
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
	const getActiveId = (role: string) => models.find((m) => m.role === role && m.is_active)?.id;

	return (
		<div className="space-y-6">
			{/* 1. Model Add */}
			<SettingsSection
				title={t("settings.sections.models.add_title", "Add Model")}
				icon={<HardDrive size={18} />}
				description={t(
					"settings.sections.models.add_description",
					"Add new models to your local library.",
				)}
			>
				<AddModelForm onModelAdded={fetchModels} />
			</SettingsSection>

			{/* 2. Model List */}
			<SettingsSection
				title={t("settings.sections.models.list_title") || "Model List"}
				icon={<List size={18} />}
				description={
					t("settings.sections.models.list_description") ||
					"Manage, delete, and reorder registered models."
				}
			>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => setIsOverlayOpen(true)}
						className="flex-1 py-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center gap-2 hover:bg-white/10 transition-colors text-gray-300 hover:text-white"
					>
						<List size={18} />
						<span>{t("settings.sections.models.manage_models") || "Manage Models"}</span>
					</button>

					<button
						type="button"
						onClick={handleRefreshOllama}
						disabled={isRefreshing}
						className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center gap-2 hover:bg-white/10 transition-colors text-gray-300 hover:text-white disabled:opacity-50"
						title={t("settings.sections.models.refresh_ollama") || "Refresh Ollama Models"}
					>
						<RefreshCw size={18} className={isRefreshing ? "animate-spin" : ""} />
						<span className="text-xs">Ollama</span>
					</button>

					<button
						type="button"
						onClick={handleRefreshLmStudio}
						disabled={isRefreshingLmStudio}
						className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center gap-2 hover:bg-white/10 transition-colors text-gray-300 hover:text-white disabled:opacity-50"
						title={t("settings.sections.models.refresh_lmstudio") || "Refresh LM Studio Models"}
					>
						<RefreshCw size={18} className={isRefreshingLmStudio ? "animate-spin" : ""} />
						<span className="text-xs">LM Studio</span>
					</button>
				</div>
			</SettingsSection>

			{/* 3. Model Defaults */}
			<SettingsSection
				title={t("settings.sections.models.defaults_title", "Model Defaults")}
				icon={<MessageSquare size={18} />}
				description={t(
					"settings.sections.models.defaults_description",
					"Assign default models for characters and professional tasks.",
				)}
			>
				<div className="space-y-6">
					<div className="space-y-3">
						<h3 className="text-sm font-medium text-gray-300">
							{t("settings.sections.models.character_model_title")}
						</h3>
						<ModelSelectionRow
							label={t("settings.sections.models.character_model_label") || "Character Model"}
							selectedModelId={modelRoles.character_model_id || undefined}
							models={textModels}
							onSelect={handleSelectCharacterModel}
							config={textModelConfig}
							onUpdateConfig={(c) => updateModel("text_model", c)}
							modelRole="text"
						/>
					</div>

					<div className="border-t border-white/10" />

					<div className="space-y-4">
						<h3 className="text-sm font-medium text-gray-300">
							{t("settings.sections.models.executor_models_title")}
						</h3>
						{Object.entries(modelRoles.professional_model_map).map(([taskType, modelId]) => (
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
									taskType !== "default" ? () => handleRemoveProfessionalMapping(taskType) : undefined
								}
								icon={<Wrench size={20} />}
								modelRole="text"
							/>
						))}

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
				</div>
			</SettingsSection>

			{/* 4. Embedding Model */}
			<SettingsSection
				title={t("settings.sections.models.embedding_model_title") || "Embedding Model"}
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

			{/* 5. Model Cache */}
			<SettingsSection
				title={t("settings.sections.models.cache_title", "Model Cache")}
				icon={<Database size={18} />}
				description={t(
					"settings.descriptions.cache_size",
					"Number of models to keep loaded in memory.",
				)}
			>
				<FormGroup
					label={t("settings.fields.cache_size") || "Model Cache Limit"}
					description={t("settings.descriptions.cache_size")}
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
			</SettingsSection>

			{/* 6. Search Settings */}
			<SettingsSection
				title={t("settings.sections.models.search_title", "Search & Reranking")}
				icon={<Cpu size={18} />}
				description={t(
					"settings.sections.models.search_description",
					"Configure search result reranking with embedding models.",
				)}
			>
				<FormGroup
					label={t("settings.fields.embedding_rerank.label", "Embedding Rerank")}
					description={t("settings.fields.embedding_rerank.description", "Use embedding model to rerank search results for better relevance.")}
					orientation="horizontal"
				>
					<FormSwitch
						checked={config.search?.embedding_rerank ?? false}
						onChange={(val) => updateSearch("embedding_rerank", val)}
					/>
				</FormGroup>
			</SettingsSection>

			{/* 7. Model Download Policy */}
			<SettingsSection
				title={t("settings.sections.models.download_policy_title", "Model Download Policy")}
				icon={<Shield size={18} />}
				description={t(
					"settings.sections.models.download_policy_description",
					"Security controls for downloading models from remote repositories.",
				)}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.fields.require_allowlist.label", "Require Allowlist")}
						description={t("settings.fields.require_allowlist.description", "Only allow downloads from approved repository owners.")}
						orientation="horizontal"
					>
						<FormSwitch
							checked={config.model_download?.require_allowlist ?? false}
							onChange={(val) => updateModelDownload("require_allowlist", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.warn_on_unlisted.label", "Warn on Unlisted")}
						description={t("settings.fields.warn_on_unlisted.description", "Show a warning when downloading from an unlisted owner.")}
						orientation="horizontal"
					>
						<FormSwitch
							checked={config.model_download?.warn_on_unlisted ?? true}
							onChange={(val) => updateModelDownload("warn_on_unlisted", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.require_revision.label", "Require Revision")}
						description={t("settings.fields.require_revision.description", "Require a specific revision when downloading models.")}
						orientation="horizontal"
					>
						<FormSwitch
							checked={config.model_download?.require_revision ?? false}
							onChange={(val) => updateModelDownload("require_revision", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.require_sha256.label", "Require SHA256")}
						description={t("settings.fields.require_sha256.description", "Require SHA256 verification for downloaded models.")}
						orientation="horizontal"
					>
						<FormSwitch
							checked={config.model_download?.require_sha256 ?? false}
							onChange={(val) => updateModelDownload("require_sha256", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.allow_repo_owners.label", "Allowed Repository Owners")}
						description={t("settings.fields.allow_repo_owners.description", "List of approved repository owners for model downloads.")}
					>
						<FormList
							items={config.model_download?.allow_repo_owners ?? []}
							onChange={(items) => updateModelDownload("allow_repo_owners", items)}
							placeholder={t("settings.fields.allow_repo_owners.placeholder", "e.g. TheBloke")}
						/>
					</FormGroup>
				</div>
			</SettingsSection>

			{/* 8. Loader Base URLs */}
			<SettingsSection
				title={t("settings.sections.models.loaders_title", "Loader Endpoints")}
				icon={<RefreshCw size={18} />}
				description={t(
					"settings.sections.models.loaders_description",
					"Configure base URLs for external model providers.",
				)}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.fields.ollama_base_url.label", "Ollama Base URL")}
						description={t("settings.fields.ollama_base_url.description", "URL of the Ollama server (default: http://localhost:11434).")}
					>
						<FormInput
							value={config.loaders?.ollama?.base_url ?? "http://localhost:11434"}
							onChange={(v) => updateLoaderBaseUrl("ollama", v as string)}
							placeholder="http://localhost:11434"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.lmstudio_base_url.label", "LM Studio Base URL")}
						description={t("settings.fields.lmstudio_base_url.description", "URL of the LM Studio server (default: http://localhost:1234).")}
					>
						<FormInput
							value={config.loaders?.lmstudio?.base_url ?? "http://localhost:1234"}
							onChange={(v) => updateLoaderBaseUrl("lmstudio", v as string)}
							placeholder="http://localhost:1234"
						/>
					</FormGroup>
				</div>
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
