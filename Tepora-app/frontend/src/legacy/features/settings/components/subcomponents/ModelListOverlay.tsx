import {
	AlertCircle,
	ArrowDown,
	ArrowUp,
	CheckCircle,
	Download,
	List,
	RefreshCw,
	Trash2,
	X,
	GripVertical,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FitText } from "../../../../components/ui/FitText";
import { useModelUpdateCheck } from "../../../../hooks/useModelUpdateCheck";
import { apiClient } from "../../../../../utils/api-client";
import { logger } from "../../../../../utils/logger";

interface ModelInfo {
	id: string;
	display_name: string;
	role: string;
	file_size: number;
	filename?: string;
	source: string;
	loader?: string;
}

interface ModelListOverlayProps {
	isOpen: boolean;
	onClose: () => void;
	models: ModelInfo[];
	onDelete: (id: string) => void;
	onReorder: (role: string, newOrder: string[]) => void;
	initialRole?: "text" | "embedding";
	fixedRole?: "text" | "embedding";
}

export const ModelListOverlay: React.FC<ModelListOverlayProps> = ({
	isOpen,
	onClose,
	models,
	onDelete,
	onReorder,
	initialRole = "text",
	fixedRole,
}) => {
	const { t } = useTranslation();
	const [activeTab, setActiveTab] = useState<"text" | "embedding">(initialRole);
	const { updateStatus, isChecking, checkAllModels } = useModelUpdateCheck();
	const [updatingModels, setUpdatingModels] = useState<Set<string>>(new Set());
	const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

	useEffect(() => {
		if (fixedRole) {
			setActiveTab(fixedRole);
			return;
		}
		setActiveTab(initialRole);
	}, [fixedRole, initialRole]);

	if (!isOpen) return null;

	const currentRole = fixedRole || activeTab;
	const filteredModels = models.filter((m) => m.role === currentRole);

	const handleCheckUpdates = () => {
		checkAllModels(filteredModels.map((m) => m.id));
	};

	const handleUpdate = async (model: ModelInfo) => {
		if (!model.filename) return;

		setUpdatingModels((prev) => new Set(prev).add(model.id));
		try {
			await apiClient.post("api/setup/model/download", {
				repo_id: model.source,
				filename: model.filename,
				role: model.role,
				display_name: model.display_name,
				acknowledge_warnings: true,
			});
			logger.log("Download started for", model.display_name);
		} catch (error) {
			logger.error("Failed to start update", error);
		} finally {
			setTimeout(() => {
				setUpdatingModels((prev) => {
					const next = new Set(prev);
					next.delete(model.id);
					return next;
				});
			}, 2000);
		}
	};

	const move = (index: number, direction: "up" | "down") => {
		const newModels = [...filteredModels];
		const swapIndex = direction === "up" ? index - 1 : index + 1;

		if (swapIndex < 0 || swapIndex >= newModels.length) return;

		[newModels[index], newModels[swapIndex]] = [newModels[swapIndex], newModels[index]];

		onReorder(
			currentRole,
			newModels.map((m) => m.id),
		);
	};

	const handleDragStart = (index: number) => {
		setDraggedIndex(index);
	};

	const handleDragOver = (e: React.DragEvent, index: number) => {
		e.preventDefault();
		if (draggedIndex === null || draggedIndex === index) return;

		const newModels = [...filteredModels];
		const draggedModel = newModels[draggedIndex];
		newModels.splice(draggedIndex, 1);
		newModels.splice(index, 0, draggedModel);

		onReorder(
			currentRole,
			newModels.map((m) => m.id),
		);
		setDraggedIndex(index);
	};

	const handleDragEnd = () => {
		setDraggedIndex(null);
	};

	return createPortal(
		<div
			className="fixed inset-0 z-[200] flex justify-end bg-black/60 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-labelledby="model-list-overlay-title"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div className="bg-[#1a1a1a] w-full max-w-lg h-full flex flex-col shadow-[-10px_0_30px_rgba(0,0,0,0.5)] animate-in slide-in-from-right duration-300 border-l border-white/10">
				<div className="flex items-center justify-between p-6 border-b border-white/5 bg-white/[0.02]">
					<h3 id="model-list-overlay-title" className="flex items-center gap-3 min-w-0 flex-1">
						<List size={22} className="text-gold-400" />
						<div className="min-w-0 h-7 flex items-center">
							<FitText className="text-xl font-medium text-white" minFontSize={14} maxFontSize={20}>
								{fixedRole === "embedding"
									? t("settings.sections.models.embedding_model_title", "Embedding Models")
									: fixedRole === "text"
										? t("settings.sections.models.text_model_title", "Text Models")
										: t("settings.sections.models.manage_models", "Model Management")}
							</FitText>
						</div>
					</h3>
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={handleCheckUpdates}
							disabled={isChecking}
							className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isChecking
								? "bg-white/5 text-gray-500 cursor-not-allowed"
								: "bg-surface-gold/10 text-gold-400 hover:bg-surface-gold/20"
								}`}
						>
							<RefreshCw size={14} className={isChecking ? "animate-spin" : ""} />
							<span className="hidden sm:inline">
								{isChecking
									? t("settings.sections.models.checking")
									: t("settings.sections.models.check_updates")}
							</span>
						</button>
						<button
							type="button"
							onClick={onClose}
							className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
							aria-label={t("common.aria.close")}
						>
							<X size={22} />
						</button>
					</div>
				</div>

				{!fixedRole && (
					<div className="flex border-b border-white/5 px-6">
						{(["text", "embedding"] as const).map((role) => (
							<button
								type="button"
								key={role}
								onClick={() => setActiveTab(role)}
								className={`py-4 mr-8 text-sm font-medium border-b-2 transition-colors ${activeTab === role
									? "text-gold-400 border-gold-400"
									: "text-gray-500 border-transparent hover:text-gray-300"
									}`}
							>
								{role.charAt(0).toUpperCase() + role.slice(1)} (
								{models.filter((m) => m.role === role).length})
							</button>
						))}
					</div>
				)}

				<div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar bg-black/20">
					{filteredModels.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-40 text-gray-500 gap-3">
							<List size={32} className="opacity-20" />
							<span>{t("settings.sections.models.no_models_for_role") || "No models found for this role."}</span>
						</div>
					) : (
						filteredModels.map((model, index) => (
							<div
								key={model.id}
								draggable
								onDragStart={() => handleDragStart(index)}
								onDragOver={(e) => handleDragOver(e, index)}
								onDragEnd={handleDragEnd}
								className={`bg-white/5 p-4 rounded-xl flex items-center justify-between group hover:bg-white/10 transition-all border border-white/5 hover:border-white/20 cursor-grab active:cursor-grabbing ${draggedIndex === index ? "opacity-50 scale-[0.98]" : ""}`}
							>
								<div className="flex items-center gap-4 flex-1 min-w-0">
									<div className="text-gray-600 hover:text-gray-400 hidden sm:block shrink-0">
										<GripVertical size={18} />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2 mb-1">
											<div className="font-medium text-white truncate text-sm sm:text-base">{model.display_name}</div>
											{model.loader && (
												<span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 border font-medium ${model.loader === "ollama"
														? "bg-orange-500/10 text-orange-400 border-orange-500/20"
														: model.loader === "lmstudio"
															? "bg-purple-500/10 text-purple-400 border-purple-500/20"
															: "bg-blue-500/10 text-blue-400 border-blue-500/20"
													}`}>
													{model.loader === "llama_cpp" ? "Local" :
														model.loader === "lmstudio" ? "LM Studio" :
															model.loader === "ollama" ? "Ollama" : model.loader}
												</span>
											)}
										</div>
										<div className="text-xs text-gray-500 truncate flex items-center gap-2">
											<span className="truncate max-w-[150px] sm:max-w-xs">{model.filename || model.source}</span>
											<span>•</span>
											<span className="shrink-0">{(model.file_size / 1024 / 1024).toFixed(1)} MB</span>
										</div>
									</div>
								</div>

								<div className="flex items-center gap-3 shrink-0 ml-4">
									{updateStatus[model.id] && (
										<div className="mr-2">
											{updateStatus[model.id].update_available ? (
												<div className="flex items-center gap-2">
													<span className="hidden sm:flex text-xs text-gold-400 items-center gap-1 bg-surface-gold/10 px-2 py-1 rounded">
														<Download size={12} />
														{t("settings.sections.models.update_available")}
													</span>
													<button
														type="button"
														onClick={() => handleUpdate(model)}
														disabled={updatingModels.has(model.id)}
														className="p-1.5 bg-gold-500/10 hover:bg-gold-500/20 text-gold-400 rounded-md transition-colors"
														title={t("settings.sections.models.update_btn")}
													>
														{updatingModels.has(model.id) ? (
															<RefreshCw size={14} className="animate-spin" />
														) : (
															<Download size={14} />
														)}
													</button>
												</div>
											) : updateStatus[model.id].reason === "up_to_date" ? (
												<span className="hidden sm:flex text-xs text-green-400 items-center gap-1">
													<CheckCircle size={12} />
													{t("settings.sections.models.up_to_date")}
												</span>
											) : (
												<span
													className="text-xs text-gray-500 flex items-center gap-1"
													title={updateStatus[model.id].reason}
												>
													<AlertCircle size={12} />
												</span>
											)}
										</div>
									)}

									<div className="flex items-center gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 rounded-lg p-1">
										<button
											type="button"
											onClick={() => move(index, "up")}
											disabled={index === 0}
											className="p-1.5 hover:bg-white/10 rounded-md disabled:opacity-30 text-gray-400 hover:text-white transition-colors"
											aria-label={t("common.aria.move_up")}
										>
											<ArrowUp size={14} />
										</button>
										<button
											type="button"
											onClick={() => move(index, "down")}
											disabled={index === filteredModels.length - 1}
											className="p-1.5 hover:bg-white/10 rounded-md disabled:opacity-30 text-gray-400 hover:text-white transition-colors"
											aria-label={t("common.aria.move_down")}
										>
											<ArrowDown size={14} />
										</button>
									</div>
									<button
										type="button"
										onClick={() => onDelete(model.id)}
										className="p-2 hover:bg-red-500/20 text-red-400 hover:text-red-300 rounded-lg transition-colors ml-1"
										aria-label={t("common.aria.delete")}
									>
										<Trash2 size={16} />
									</button>
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
};

