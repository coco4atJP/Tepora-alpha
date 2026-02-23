import { Cpu, Database, HardDrive, List, MessageSquare, RefreshCw, SlidersHorizontal, Wrench } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
import { modelsApi, resolveEmbeddingModelPath } from "../../../../api/models";
import type { ModelRoles } from "../../../../api/models";
import { loadersApi } from "../../../../api/loaders";
import { FormGroup, FormInput, FormSwitch, SettingsSection } from "../SettingsComponents";
import { AddModelForm } from "../subcomponents/AddModelForm";
import { ModelListOverlay } from "../subcomponents/ModelListOverlay";
import { ModelSelectionRow } from "../subcomponents/ModelSelectionRow";
import ModelHub from "../../../../pages/ModelHub";
import type { ModelInfo } from "../../../../types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPathValue<T>(source: unknown, path: string, fallback: T): T {
	const keys = path.split(".").filter(Boolean);
	let current: unknown = source;

	for (const key of keys) {
		if (!isRecord(current)) return fallback;
		current = current[key];
	}

	if (current === undefined || current === null) return fallback;
	return current as T;
}

const ModelSettings: React.FC = () => {
	const { t } = useTranslation();
	const {
		config,
		originalConfig,
		customAgents,
		updateLlmManager,
		updateModel,
		updateSearch,
		updateLoaderBaseUrl,
		updateConfigPath,
	} = useSettings();
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [listOverlayRole, setListOverlayRole] = useState<"text" | "embedding" | null>(null);
	const [isModelHubOpen, setIsModelHubOpen] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isRefreshingLmStudio, setIsRefreshingLmStudio] = useState(false);
	const [modelRoles, setModelRoles] = useState<ModelRoles>({
		character_model_id: null,
		character_model_map: {},
		agent_model_map: {},
		professional_model_map: {},
	});

	// Fetch available models from backend
	const fetchModels = useCallback(async () => {
		try {
			const data = await modelsApi.list();
			setModels(data.models || []);
		} catch (e) {
			console.error("Failed to fetch models", e);
		}
	}, []);

	const fetchModelRoles = useCallback(async () => {
		try {
			const data = await modelsApi.getRoles();
			setModelRoles({
				character_model_id: data.character_model_id || null,
				character_model_map: data.character_model_map || {},
				agent_model_map: data.agent_model_map || {},
				professional_model_map: data.professional_model_map || {},
			});
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
			await modelsApi.setCharacterRole(modelId);
			await fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleSelectCharacterScopedModel = async (characterId: string, modelId: string) => {
		try {
			if (modelId) {
				await modelsApi.setCharacterScopedRole(characterId, modelId);
			} else {
				await modelsApi.deleteCharacterScopedRole(characterId);
			}
			await fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleSelectAgentScopedModel = async (agentId: string, modelId: string) => {
		try {
			if (modelId) {
				await modelsApi.setAgentScopedRole(agentId, modelId);
			} else {
				await modelsApi.deleteAgentScopedRole(agentId);
			}
			await fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleSelectProfessionalModel = async (taskType: string, modelId: string) => {
		try {
			await modelsApi.setProfessionalRole(taskType, modelId);
			await fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
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
			await modelsApi.delete(id);
			fetchModels();
			fetchModelRoles();
		} catch (e) {
			console.error(e);
		}
	};

	const handleReorder = async (role: string, ids: string[]) => {
		try {
			await modelsApi.reorder(role, ids);
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
			await modelsApi.setActive(modelId, "embedding");
			await fetchModels();
			const modelInList = models.find((m) => m.id === modelId);
			if (modelInList) {
				const modelPath = resolveEmbeddingModelPath(modelInList);
				if (modelPath) {
					updateModel("embedding_model", {
						...embeddingModelConfig,
						path: modelPath,
					});
				}
			}
		} catch (e) {
			console.error(e);
		}
	};

	const textModels = models.filter((m) => m.role === "text");
	const embeddingModels = models.filter((m) => m.role === "embedding");
	const getActiveId = (role: string) => models.find((m) => m.role === role && m.is_active)?.id;
	const characterEntries = Object.entries(config.characters || {});
	const customAgentEntries = Object.values(customAgents || {}).sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return a.name.localeCompare(b.name);
	});

	const readString = (path: string, fallback = "") => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "string" ? value : fallback;
	};

	const readBoolean = (path: string, fallback = false) => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "boolean" ? value : fallback;
	};

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
				<div className="space-y-3">
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
						<button
							type="button"
							onClick={() => setListOverlayRole("text")}
							className="py-3 glass-button rounded-xl flex items-center justify-center gap-2 text-tea-200/90 hover:text-gold-300 font-semibold tracking-wide"
						>
							<MessageSquare size={18} />
							<span>{t("settings.sections.models.text_model_title") || "Text Models"}</span>
						</button>
						<button
							type="button"
							onClick={() => setListOverlayRole("embedding")}
							className="py-3 glass-button rounded-xl flex items-center justify-center gap-2 text-tea-200/90 hover:text-gold-300 font-semibold tracking-wide"
						>
							<Cpu size={18} />
							<span>{t("settings.sections.models.embedding_model_title") || "Embedding Models"}</span>
						</button>
						<button
							type="button"
							onClick={() => setIsModelHubOpen(true)}
							className="py-3 glass-button rounded-xl flex items-center justify-center gap-2 text-tea-200/90 hover:text-gold-300 font-semibold tracking-wide"
						>
							<List size={18} />
							<span>{t("modelHub.title") || "Visual Model Hub"}</span>
						</button>
					</div>

					<div className="flex gap-3 sm:w-auto w-full">
						<button
							type="button"
							onClick={handleRefreshOllama}
							disabled={isRefreshing}
							className="flex-1 sm:flex-none px-4 py-3 glass-button rounded-xl flex items-center justify-center gap-2 text-tea-200/80 hover:text-gold-300 disabled:opacity-50"
							title={t("settings.sections.models.refresh_ollama") || "Refresh Ollama Models"}
						>
							<RefreshCw size={18} className={isRefreshing ? "animate-spin text-gold-400" : ""} />
							<span className="text-xs font-bold uppercase tracking-wider">Ollama</span>
						</button>

						<button
							type="button"
							onClick={handleRefreshLmStudio}
							disabled={isRefreshingLmStudio}
							className="flex-1 sm:flex-none px-4 py-3 glass-button rounded-xl flex items-center justify-center gap-2 text-tea-200/80 hover:text-gold-300 disabled:opacity-50"
							title={t("settings.sections.models.refresh_lmstudio") || "Refresh LM Studio Models"}
						>
							<RefreshCw size={18} className={isRefreshingLmStudio ? "animate-spin text-gold-400" : ""} />
							<span className="text-xs font-bold uppercase tracking-wider">LM Studio</span>
						</button>
					</div>
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

					<div className="space-y-3">
						<h3 className="text-sm font-medium text-gray-300">
							{t("settings.sections.models.character_roles_title", "Character Role Mapping")}
						</h3>
						<p className="text-xs text-gray-500">
							{t(
								"settings.sections.models.character_roles_desc",
								"Assign a dedicated text model per character. Leave empty to inherit the global character model.",
							)}
						</p>
						<div className="space-y-2">
							{characterEntries.map(([characterId, character]) => (
								<div
									key={characterId}
									className="bg-black/20 border border-white/5 rounded-xl px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center"
								>
									<div className="flex-1 min-w-0">
										<div className="text-sm text-white truncate">
											{character.name || characterId}
										</div>
										<div className="text-xs text-gray-500 font-mono">
											@{characterId}
											{config.active_agent_profile === characterId
												? ` • ${t("common.active", "Active")}`
												: ""}
										</div>
									</div>
									<div className="w-full md:w-[360px]">
										<select
											value={modelRoles.character_model_map[characterId] || ""}
											onChange={(e) =>
												handleSelectCharacterScopedModel(characterId, e.target.value)
											}
											className="w-full appearance-none bg-white/5 border border-white/10 hover:border-white/20 rounded-xl px-4 py-2.5 text-white text-sm transition-colors focus:outline-none focus:border-gold-400/50"
										>
											<option value="" className="bg-gray-900">
												{t("settings.sections.models.defaults.global", "Global Default")}
											</option>
											{textModels.map((model) => (
												<option key={model.id} value={model.id} className="bg-gray-900">
													{model.display_name}
												</option>
											))}
										</select>
									</div>
								</div>
							))}
						</div>
					</div>

					<div className="border-t border-white/10" />

					<div className="space-y-3">
						<h3 className="text-sm font-medium text-gray-300">
							{t("settings.sections.models.agent_roles_title", "Custom Agent Role Mapping")}
						</h3>
						<p className="text-xs text-gray-500">
							{t(
								"settings.sections.models.agent_roles_desc",
								"Assign a text model per custom agent. Leave empty to inherit default professional/character routing.",
							)}
						</p>
						{customAgentEntries.length === 0 ? (
							<div className="text-xs text-gray-500 bg-black/20 border border-white/5 rounded-xl px-4 py-3">
								{t("settings.sections.models.no_custom_agents", "No custom agents configured.")}
							</div>
						) : (
							<div className="space-y-2">
								{customAgentEntries.map((agent) => (
									<div
										key={agent.id}
										className="bg-black/20 border border-white/5 rounded-xl px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center"
									>
										<div className="flex-1 min-w-0">
											<div className="text-sm text-white truncate">
												{agent.name || agent.id}
											</div>
											<div className="text-xs text-gray-500 font-mono">
												@{agent.id}
											</div>
										</div>
										<div className="w-full md:w-[360px]">
											<select
												value={modelRoles.agent_model_map[agent.id] || ""}
												onChange={(e) =>
													handleSelectAgentScopedModel(agent.id, e.target.value)
												}
												className="w-full appearance-none bg-white/5 border border-white/10 hover:border-white/20 rounded-xl px-4 py-2.5 text-white text-sm transition-colors focus:outline-none focus:border-gold-400/50"
											>
												<option value="" className="bg-gray-900">
													{t("settings.sections.models.defaults.global", "Global Default")}
												</option>
												{textModels.map((model) => (
													<option
														key={model.id}
														value={model.id}
														className="bg-gray-900"
													>
														{model.display_name}
													</option>
												))}
											</select>
										</div>
									</div>
								))}
							</div>
						)}
					</div>

					<div className="border-t border-white/10" />

					<div className="space-y-4">
						<h3 className="text-sm font-medium text-gray-300">
							{t("settings.sections.models.executor_models_title")}
						</h3>
						<ModelSelectionRow
							label={t("settings.sections.models.executor_default_label", "Professional Default Model")}
							description={t("settings.sections.models.executor_default_desc", "Default model used for system agent tasks. Can be overridden in specific tool settings.")}
							selectedModelId={modelRoles.professional_model_map["default"] || undefined}
							models={textModels}
							onSelect={(id) => handleSelectProfessionalModel("default", id)}
							config={textModelConfig}
							onUpdateConfig={(c) => updateModel("text_model", c)}
							icon={<Wrench size={20} />}
							modelRole="text"
						/>
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
				description={t("settings.sections.models.search_description", "Configure search result reranking with embedding models.")}
			>
				<FormGroup
					label={t("settings.fields.embedding_rerank.label", "Embedding Rerank")}
					description={t("settings.fields.embedding_rerank.description", "Use embedding model to rerank search results for better relevance.")}
				>
					<FormSwitch
						checked={config.search?.embedding_rerank ?? false}
						onChange={(val) => updateSearch("embedding_rerank", val)}
					/>
				</FormGroup>
			</SettingsSection>


			{/* 8. Loader Base URLs */}
			<SettingsSection
				title={t("settings.sections.models.loaders_title", "Loader Endpoints")}
				icon={<RefreshCw size={18} />}
				description={t("settings.sections.models.loaders_description", "Configure base URLs for external model providers.")}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.fields.ollama_base_url.label", "Ollama Base URL")}
						description={t("settings.fields.ollama_base_url.description", "URL of the Ollama server (default: http://localhost:11434).")}
					>
						<FormInput
							value={config.loaders?.ollama?.base_url ?? "http://localhost:11434"}
							onChange={(v) => updateLoaderBaseUrl("ollama", v as string)}
							placeholder={t("settings.fields.ollama_base_url.placeholder", "http://localhost:11434")}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.lmstudio_base_url.label", "LM Studio Base URL")}
						description={t("settings.fields.lmstudio_base_url.description", "URL of the LM Studio server (default: http://localhost:1234).")}
					>
						<FormInput
							value={config.loaders?.lmstudio?.base_url ?? "http://localhost:1234"}
							onChange={(v) => updateLoaderBaseUrl("lmstudio", v as string)}
							placeholder={t("settings.fields.lmstudio_base_url.placeholder", "http://localhost:1234")}
						/>
					</FormGroup>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.extended.models_title", "Model and LLM Extensions")}
				icon={<SlidersHorizontal size={18} />}
				description={t(
					"settings.sections.extended.models_description",
					"Set model defaults and advanced generation metadata not covered in the standard model cards.",
				)}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.sections.extended.character_default_model", "Character Default Model")}
					>
						<FormInput
							value={readString("model_defaults.character_default_model", "")}
							onChange={(value) => updateConfigPath("model_defaults.character_default_model", value)}
							placeholder="text_model"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.supervisor_default_model", "Supervisor/Planner Default Model")}
					>
						<FormInput
							value={readString("model_defaults.supervisor_planner_default_model", "")}
							onChange={(value) =>
								updateConfigPath("model_defaults.supervisor_planner_default_model", value)}
							placeholder="text_model"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.executor_default_model", "Executor Default Model")}
					>
						<FormInput
							value={readString("model_defaults.executor_default_model", "")}
							onChange={(value) => updateConfigPath("model_defaults.executor_default_model", value)}
							placeholder="text_model"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.logprobs", "Enable Logprobs")}
						description={t(
							"settings.sections.extended.logprobs_desc",
							"Emit token-level log probabilities where supported.",
						)}
					>
						<FormSwitch
							checked={readBoolean("models_gguf.text_model.logprobs", false)}
							onChange={(value) => updateConfigPath("models_gguf.text_model.logprobs", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.system_prompt_prefix", "System Prompt Prefix")}
						description={t(
							"settings.sections.extended.system_prompt_prefix_desc",
							"Prepended text for system prompts.",
						)}
					>
						<FormInput
							value={readString("models_gguf.text_model.system_prompt_prefix", "")}
							onChange={(value) =>
								updateConfigPath("models_gguf.text_model.system_prompt_prefix", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.system_prompt_suffix", "System Prompt Suffix")}
						description={t(
							"settings.sections.extended.system_prompt_suffix_desc",
							"Appended text for system prompts.",
						)}
					>
						<FormInput
							value={readString("models_gguf.text_model.system_prompt_suffix", "")}
							onChange={(value) =>
								updateConfigPath("models_gguf.text_model.system_prompt_suffix", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.loader_specific_text", "Text Model Loader-specific Settings")}
						description={t(
							"settings.sections.extended.loader_specific_text_desc",
							"Serialized loader-specific configuration for text model.",
						)}
					>
						<FormInput
							value={readString("models_gguf.text_model.loader_specific_settings", "")}
							onChange={(value) =>
								updateConfigPath("models_gguf.text_model.loader_specific_settings", value)}
							placeholder='{"rope_scaling":"linear"}'
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.loader_specific_embedding", "Embedding Loader-specific Settings")}
						description={t(
							"settings.sections.extended.loader_specific_embedding_desc",
							"Serialized loader-specific configuration for embedding model.",
						)}
					>
						<FormInput
							value={readString("models_gguf.embedding_model.loader_specific_settings", "")}
							onChange={(value) =>
								updateConfigPath("models_gguf.embedding_model.loader_specific_settings", value)}
							placeholder='{"rope_scaling":"linear"}'
						/>
					</FormGroup>
				</div>
			</SettingsSection>

			<ModelHub isOpen={isModelHubOpen} onClose={() => setIsModelHubOpen(false)} />
			<ModelListOverlay
				isOpen={listOverlayRole !== null}
				onClose={() => setListOverlayRole(null)}
				models={models}
				onDelete={handleDelete}
				onReorder={handleReorder}
				initialRole={listOverlayRole || "text"}
				fixedRole={listOverlayRole || undefined}
			/>
		</div>
	);
};

export default ModelSettings;
