import { Cpu, Settings, Trash2, ChevronDown } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelDetailOverlay } from "./ModelDetailOverlay";
import { ModelSelectionOverlay, type ModelInfo } from "./ModelSelectionOverlay";

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

interface ModelSelectionRowProps {
	label: string;
	description?: string;
	icon?: React.ReactNode;
	modelRole: string;
	selectedModelId: string | undefined;
	models: ModelInfo[];
	onSelect: (modelId: string) => void;

	config: ModelConfig;
	onUpdateConfig: (config: ModelConfig) => void;
	onDelete?: () => void;
}

export const ModelSelectionRow: React.FC<ModelSelectionRowProps> = ({
	label,
	description,
	icon,
	modelRole,
	selectedModelId,
	models,
	onSelect,
	config,
	onUpdateConfig,
	onDelete,
}) => {
	const { t } = useTranslation();
	const [isDetailOpen, setIsDetailOpen] = useState(false);
	const [isSelectionOpen, setIsSelectionOpen] = useState(false);

	const availableModels = models;
	const selectedModel = availableModels.find((m) => m.id === selectedModelId);

	return (
		<div className="bg-black/20 rounded-xl p-6 border border-white/5 space-y-4">
			<div className="flex items-center gap-3 mb-2">
				<div className="p-2 bg-white/5 rounded-lg text-gold-400">{icon || <Cpu size={20} />}</div>
				<div className="flex-1">
					<h3 className="text-lg font-medium text-white">{label}</h3>
					{description && <p className="text-sm text-gray-500">{description}</p>}
				</div>
				{onDelete && (
					<button
						type="button"
						onClick={onDelete}
						className="p-2 text-gray-400 hover:text-red-400 transition-colors opacity-60 hover:opacity-100"
						title={t("settings.sections.models.selection.remove_mapping") || "Remove Mapping"}
					>
						<Trash2 size={18} />
					</button>
				)}
			</div>

			<div className="flex gap-4">
				<div className="flex-1 relative">
					<button
						type="button"
						onClick={() => setIsSelectionOpen(true)}
						className="w-full text-left bg-white/5 border border-white/10 hover:border-white/20 rounded-xl px-4 py-3 pr-10 text-white font-medium transition-colors focus:outline-none focus:border-gold-400/50 flex items-center justify-between"
					>
						<span className={selectedModel ? "text-white truncate" : "text-gray-400"}>
							{selectedModel 
								? selectedModel.display_name 
								: (t("settings.sections.models.selection.select_model") || "Select a model...")}
						</span>
						<ChevronDown size={18} className="text-gray-400 shrink-0" />
					</button>
				</div>

				<button
					type="button"
					onClick={() => setIsDetailOpen(true)}
					disabled={!config}
					className={`p-3 border rounded-xl transition-colors ${!config
							? "bg-white/5 border-white/5 text-gray-600 cursor-not-allowed"
							: "bg-white/5 border-white/10 hover:bg-white/10 hover:text-white text-gray-400"
						}`}
					title={
						config
							? t("settings.sections.models.selection.configure") || "Model Configurations"
							: t("settings.sections.models.selection.no_config") || "No configuration available"
					}
				>
					<Settings size={20} />
				</button>
			</div>

			<ModelSelectionOverlay
				isOpen={isSelectionOpen}
				onClose={() => setIsSelectionOpen(false)}
				models={availableModels}
				onSelect={onSelect}
				selectedModelId={selectedModelId}
				fixedRole={modelRole as "text" | "embedding"}
			/>

			<ModelDetailOverlay
				isOpen={isDetailOpen}
				onClose={() => setIsDetailOpen(false)}
				title={`${label} Configuration`}
				config={config}
				onChange={onUpdateConfig}
				isEmbedding={modelRole === "embedding"}
			/>
		</div>
	);
};
