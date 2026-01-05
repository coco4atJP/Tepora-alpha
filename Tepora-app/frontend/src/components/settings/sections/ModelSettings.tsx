import {
	Cpu,
	HardDrive,
	List,
	MessageSquare,
	Plus,
	Settings2,
	Wrench,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getApiBase, getAuthHeaders } from "../../../utils/api";
import {
	FormGroup,
	FormInput,
	FormSelect,
	SettingsSection,
} from "../SettingsComponents";
import { AddModelForm } from "../subcomponents/AddModelForm";
import { ModelListOverlay } from "../subcomponents/ModelListOverlay";
import { ModelSelectionRow } from "../subcomponents/ModelSelectionRow";

// Types (simplified for this context)
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

interface LlmManagerConfig {
	process_terminate_timeout: number;
	health_check_timeout: number;
	health_check_interval: number;
	tokenizer_model_key: string;
}

interface ModelSettingsProps {
	llmConfig: LlmManagerConfig;
	modelsConfig: {
		text_model: ModelConfig;
		embedding_model: ModelConfig;
	};
	onUpdateLlm: (field: keyof LlmManagerConfig, value: unknown) => void;
	onUpdateModel: (
		key: keyof ModelSettingsProps["modelsConfig"],
		config: ModelConfig,
	) => void;
}

interface ModelInfo {
	id: string;
	display_name: string;
	role: string;
	file_size: number;
	filename?: string;
	source: string;
	is_active: boolean;
}

interface ModelRoles {
	character_model_id: string | null;
	executor_model_map: Record<string, string>;
}

const ModelSettings: React.FC<ModelSettingsProps> = ({
	llmConfig,
	modelsConfig,
	onUpdateLlm,
	onUpdateModel,
}) => {
	const { t } = useTranslation();
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [isOverlayOpen, setIsOverlayOpen] = useState(false);
	const [modelRoles, setModelRoles] = useState<ModelRoles>({
		character_model_id: null,
		executor_model_map: {},
	});
	const [newTaskType, setNewTaskType] = useState("");

	const fetchModels = useCallback(async () => {
		try {
			const res = await fetch(`${getApiBase()}/api/setup/models`, {
				headers: getAuthHeaders(),
			});
			if (res.ok) {
				const data = await res.json();
				setModels(data.models);
			}
		} catch (e) {
			console.error("Failed to fetch models", e);
		}
	}, []);

	const fetchModelRoles = useCallback(async () => {
		try {
			const res = await fetch(`${getApiBase()}/api/setup/model/roles`, {
				headers: getAuthHeaders(),
			});
			if (res.ok) {
				const data = await res.json();
				setModelRoles(data);
			}
		} catch (e) {
			console.error("Failed to fetch model roles", e);
		}
	}, []);

	useEffect(() => {
		fetchModels();
		fetchModelRoles();
	}, [fetchModels, fetchModelRoles]);

	const handleSelectCharacterModel = async (modelId: string) => {
		try {
			const res = await fetch(
				`${getApiBase()}/api/setup/model/roles/character`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", ...getAuthHeaders() },
					body: JSON.stringify({ model_id: modelId }),
				},
			);
			if (res.ok) {
				await fetchModelRoles();
			}
		} catch (e) {
			console.error(e);
		}
	};

	const handleSelectExecutorModel = async (
		taskType: string,
		modelId: string,
	) => {
		try {
			const res = await fetch(
				`${getApiBase()}/api/setup/model/roles/executor`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", ...getAuthHeaders() },
					body: JSON.stringify({ task_type: taskType, model_id: modelId }),
				},
			);
			if (res.ok) {
				await fetchModelRoles();
			}
		} catch (e) {
			console.error(e);
		}
	};

	const handleRemoveExecutorMapping = async (taskType: string) => {
		try {
			const res = await fetch(
				`${getApiBase()}/api/setup/model/roles/executor/${taskType}`,
				{
					method: "DELETE",
					headers: getAuthHeaders(),
				},
			);
			if (res.ok) {
				await fetchModelRoles();
			}
		} catch (e) {
			console.error(e);
		}
	};

	const handleAddTaskType = async () => {
		if (!newTaskType.trim()) return;
		// 新しいタスクタイプを追加（空のマッピングとして）
		// UIでは選択前の状態として表示され、ドロップダウンでモデルを選択すると保存される
		setModelRoles((prev) => ({
			...prev,
			executor_model_map: {
				...prev.executor_model_map,
				[newTaskType.trim()]: "",
			},
		}));
		setNewTaskType("");
	};

	// Legacy: set pool active model for embedding only now
	const handleSelectEmbeddingModel = async (modelId: string) => {
		try {
			const res = await fetch(`${getApiBase()}/api/setup/model/active`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...getAuthHeaders() },
				body: JSON.stringify({ model_id: modelId, role: "embedding" }),
			});

			if (res.ok) {
				await fetchModels();
				const modelInList = models.find((m) => m.id === modelId);
				if (modelInList?.filename) {
					onUpdateModel("embedding_model", {
						...modelsConfig.embedding_model,
						path: `models/embedding/${modelInList.filename}`,
					});
				}
			}
		} catch (e) {
			console.error(e);
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm("Are you sure you want to delete this model?")) return;
		try {
			const res = await fetch(`${getApiBase()}/api/setup/model/${id}`, {
				method: "DELETE",
				headers: getAuthHeaders(),
			});
			if (res.ok) {
				fetchModels();
				fetchModelRoles();
			}
		} catch (e) {
			console.error(e);
		}
	};

	const handleReorder = async (role: string, ids: string[]) => {
		try {
			await fetch(`${getApiBase()}/api/setup/model/reorder`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...getAuthHeaders() },
				body: JSON.stringify({ role, model_ids: ids }),
			});
			fetchModels();
		} catch (e) {
			console.error(e);
		}
	};

	const getActiveId = (role: string) =>
		models.find((m) => m.role === role && m.is_active)?.id;
	const textModels = models.filter((m) => m.role === "text");

	return (
		<div className="space-y-6">
			{/* 1. Model Management Section */}
			<SettingsSection
				title={
					t("settings.models_settings.download_manager.title") ||
					"Model Management"
				}
				icon={<HardDrive size={18} />}
				description="Manage your local model library."
			>
				<div className="space-y-4">
					<AddModelForm onModelAdded={fetchModels} />

					<button
						onClick={() => setIsOverlayOpen(true)}
						className="w-full py-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center gap-2 hover:bg-white/10 transition-colors text-gray-300 hover:text-white"
					>
						<List size={18} />
						<span>Manage Models (Delete / Reorder)</span>
					</button>
				</div>
			</SettingsSection>

			{/* 2. Character Model Selection */}
			<SettingsSection
				title="Character Model"
				icon={<MessageSquare size={18} />}
				description="Select the model used for conversation and persona-based responses."
			>
				<ModelSelectionRow
					label="Character Model"
					selectedModelId={modelRoles.character_model_id || undefined}
					models={textModels}
					onSelect={handleSelectCharacterModel}
					config={modelsConfig.text_model}
					onUpdateConfig={(c) => onUpdateModel("text_model", c)}
					role="text"
				/>
			</SettingsSection>

			{/* 3. Executor Models Selection (Task Type based) */}
			<SettingsSection
				title="Executor Models"
				icon={<Wrench size={18} />}
				description="Configure models for different task types. Each task can use a specialized model."
			>
				<div className="space-y-4">
					{Object.entries(modelRoles.executor_model_map).map(
						([taskType, modelId]) => (
							<ModelSelectionRow
								key={taskType}
								label={`Executor: ${taskType}`}
								description={
									taskType === "default"
										? "Default fallback executor model."
										: `Specialized model for ${taskType} tasks.`
								}
								selectedModelId={modelId}
								models={textModels}
								onSelect={(id) => handleSelectExecutorModel(taskType, id)}
								config={modelsConfig.text_model}
								onUpdateConfig={(c) => onUpdateModel("text_model", c)}
								onDelete={
									taskType !== "default"
										? () => handleRemoveExecutorMapping(taskType)
										: undefined
								}
								icon={<Wrench size={20} />}
								role="text"
							/>
						),
					)}

					{/* Add new task type */}
					<div className="flex gap-2">
						<input
							type="text"
							value={newTaskType}
							onChange={(e) => setNewTaskType(e.target.value)}
							placeholder="Add task type (e.g., coding, browser)..."
							className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-gold-400/50"
							onKeyDown={(e) => e.key === "Enter" && handleAddTaskType()}
						/>
						<button
							onClick={handleAddTaskType}
							disabled={!newTaskType.trim()}
							className="px-4 py-2.5 bg-gold-400/20 text-gold-400 rounded-xl hover:bg-gold-400/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
						>
							<Plus size={18} />
							<span>Add</span>
						</button>
					</div>
				</div>
			</SettingsSection>

			{/* 4. Embedding Model Selection */}
			<SettingsSection
				title="Embedding Model"
				icon={<Cpu size={18} />}
				description="Select the model used for memory and retrieval."
			>
				<ModelSelectionRow
					label=""
					selectedModelId={getActiveId("embedding")}
					models={models.filter((m) => m.role === "embedding")}
					onSelect={handleSelectEmbeddingModel}
					config={modelsConfig.embedding_model}
					onUpdateConfig={(c) => onUpdateModel("embedding_model", c)}
					role="embedding"
				/>
			</SettingsSection>

			{/* 5. Global Settings */}
			<SettingsSection
				title={t("settings.models_settings.global_manager.title")}
				icon={<Settings2 size={18} />}
				description={t("settings.models_settings.global_manager.description")}
			>
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
					<FormGroup
						label={t(
							"settings.models_settings.global_manager.terminate_timeout",
						)}
					>
						<FormInput
							type="number"
							value={llmConfig.process_terminate_timeout}
							onChange={(v) => onUpdateLlm("process_terminate_timeout", v)}
							min={1}
						/>
					</FormGroup>
					<FormGroup
						label={t(
							"settings.models_settings.global_manager.health_check_timeout",
						)}
					>
						<FormInput
							type="number"
							value={llmConfig.health_check_timeout}
							onChange={(v) => onUpdateLlm("health_check_timeout", v)}
							min={1}
						/>
					</FormGroup>
					<FormGroup
						label={t(
							"settings.models_settings.global_manager.health_check_interval",
						)}
					>
						<FormInput
							type="number"
							value={llmConfig.health_check_interval}
							onChange={(v) => onUpdateLlm("health_check_interval", v)}
							step={0.1}
						/>
					</FormGroup>
					<FormGroup
						label={t("settings.models_settings.global_manager.tokenizer_model")}
					>
						<FormSelect
							value={llmConfig.tokenizer_model_key}
							onChange={(v) => onUpdateLlm("tokenizer_model_key", v)}
							options={[
								{ value: "text_model", label: "Text" },
								{ value: "embedding_model", label: "Embedding" },
							]}
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
