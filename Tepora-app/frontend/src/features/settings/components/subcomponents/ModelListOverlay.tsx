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
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FitText } from "../../../../components/ui/FitText";
import { useModelUpdateCheck } from "../../../../hooks/useModelUpdateCheck";
import { apiClient } from "../../../../utils/api-client";

interface ModelInfo {
	id: string;
	display_name: string;
	role: string;
	file_size: number;
	filename?: string;
	source: string;
}

interface ModelListOverlayProps {
	isOpen: boolean;
	onClose: () => void;
	models: ModelInfo[];
	onDelete: (id: string) => void;
	onReorder: (role: string, newOrder: string[]) => void;
}

export const ModelListOverlay: React.FC<ModelListOverlayProps> = ({
	isOpen,
	onClose,
	models,
	onDelete,
	onReorder,
}) => {
	const { t } = useTranslation();
	const [activeTab, setActiveTab] = useState("text");
	const { updateStatus, isChecking, checkAllModels } = useModelUpdateCheck();
	const [updatingModels, setUpdatingModels] = useState<Set<string>>(new Set());

	if (!isOpen) return null;

	const filteredModels = models.filter((m) => m.role === activeTab);

	const handleCheckUpdates = () => {
		checkAllModels(filteredModels.map((m) => m.id));
	};

	const handleUpdate = async (model: ModelInfo) => {
		if (!model.filename) return;

		setUpdatingModels((prev) => new Set(prev).add(model.id));
		try {
			await apiClient.post("api/setup/model/download", {
				repo_id: model.source, // Assuming source is repo_id for now
				filename: model.filename,
				role: model.role,
				display_name: model.display_name,
				acknowledge_warnings: true,
			});
			// Ideally we would switch to a download progress view here
			// For now, we'll just alert (or rely on the toast system if available)
			console.log("Download started for", model.display_name);
		} catch (error) {
			console.error("Failed to start update", error);
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
			activeTab,
			newModels.map((m) => m.id),
		);
	};

	return createPortal(
		<div
			className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
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
			<div className="glass-tepora rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl animate-in fade-in zoom-in-95 duration-200">
				<div className="flex items-center justify-between p-6 border-b border-white/5 bg-white/[0.02]">
					<h3 id="model-list-overlay-title" className="flex items-center gap-2 min-w-0 flex-1">
						<List size={20} className="text-gold-400" />
						<div className="min-w-0 h-7 flex items-center">
							<FitText className="text-lg font-medium text-white" minFontSize={12} maxFontSize={18}>
								{t("settings.sections.models.manage_models") || "Model Management"}
							</FitText>
						</div>
					</h3>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={handleCheckUpdates}
							disabled={isChecking}
							className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
								isChecking
									? "bg-white/5 text-gray-500 cursor-not-allowed"
									: "bg-surface-gold/10 text-gold-400 hover:bg-surface-gold/20"
							}`}
						>
							<RefreshCw size={14} className={isChecking ? "animate-spin" : ""} />
							{isChecking
								? t("settings.sections.models.checking")
								: t("settings.sections.models.check_updates")}
						</button>
						<button
							type="button"
							onClick={onClose}
							className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
							aria-label={t("common.aria.close")}
						>
							<X size={20} />
						</button>
					</div>
				</div>

				<div className="flex border-b border-white/5 px-6">
					{["text", "embedding"].map((role) => (
						<button
							type="button"
							key={role}
							onClick={() => setActiveTab(role)}
							className={`py-3 mr-6 text-sm font-medium border-b-2 transition-colors ${
								activeTab === role
									? "text-gold-400 border-gold-400"
									: "text-gray-500 border-transparent hover:text-gray-300"
							}`}
						>
							{role.charAt(0).toUpperCase() + role.slice(1)} (
							{models.filter((m) => m.role === role).length})
						</button>
					))}
				</div>

				<div className="flex-1 overflow-y-auto p-6 space-y-2 custom-scrollbar">
					{filteredModels.length === 0 ? (
						<div className="text-center text-gray-500 py-10">
							{t("settings.sections.models.no_models_for_role") || "No models found for this role."}
						</div>
					) : (
						filteredModels.map((model, index) => (
							<div
								key={model.id}
								className="bg-black/20 p-4 rounded-lg flex items-center justify-between group hover:bg-white/5 transition-colors border border-transparent hover:border-white/5"
							>
								<div>
									<div className="font-medium text-white">{model.display_name}</div>
									<div className="text-xs text-gray-500">
										{model.filename || model.source} • {(model.file_size / 1024 / 1024).toFixed(1)}{" "}
										MB
									</div>
								</div>

								{/* Status Badge */}
								{updateStatus[model.id] && (
									<div className="mr-4">
										{updateStatus[model.id].update_available ? (
											<div className="flex items-center gap-2">
												<span className="text-xs text-gold-400 flex items-center gap-1 bg-surface-gold/10 px-2 py-1 rounded">
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
											<span className="text-xs text-green-400 flex items-center gap-1">
												<CheckCircle size={12} />
												{t("settings.sections.models.up_to_date")}
											</span>
										) : (
											<span
												className="text-xs text-gray-500 flex items-center gap-1"
												title={updateStatus[model.id].reason}
											>
												<AlertCircle size={12} />
												{t("settings.sections.models.check_failed")}
											</span>
										)}
									</div>
								)}

								<div className="flex items-center gap-2 opacity-100 sm:opacity-50 group-hover:opacity-100 transition-opacity">
									<button
										type="button"
										onClick={() => move(index, "up")}
										disabled={index === 0}
										className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 text-gray-400 hover:text-white transition-colors"
										aria-label={t("common.aria.move_up")}
									>
										<ArrowUp size={16} />
									</button>
									<button
										type="button"
										onClick={() => move(index, "down")}
										disabled={index === filteredModels.length - 1}
										className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 text-gray-400 hover:text-white transition-colors"
										aria-label={t("common.aria.move_down")}
									>
										<ArrowDown size={16} />
									</button>
									<div className="w-px h-6 bg-white/10 mx-2" />
									<button
										type="button"
										onClick={() => onDelete(model.id)}
										className="p-2 hover:bg-red-500/20 text-red-400 hover:text-red-300 rounded-full transition-colors"
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
