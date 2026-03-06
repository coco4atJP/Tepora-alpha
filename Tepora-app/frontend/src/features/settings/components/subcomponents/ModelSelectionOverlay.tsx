import {
	List,
	X,
	CheckCircle,
	Search
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FitText } from "../../../../components/ui/FitText";

export interface ModelInfo {
	id: string;
	display_name: string;
	role: string;
	file_size: number;
	filename?: string;
	source: string;
	loader?: string;
}

export interface ModelSelectionOverlayProps {
	isOpen: boolean;
	onClose: () => void;
	models: ModelInfo[];
	onSelect: (modelId: string) => void;
	selectedModelId?: string;
	initialRole?: "text" | "embedding";
	fixedRole?: "text" | "embedding";
}

export const ModelSelectionOverlay: React.FC<ModelSelectionOverlayProps> = ({
	isOpen,
	onClose,
	models,
	onSelect,
	selectedModelId,
	initialRole = "text",
	fixedRole,
}) => {
	const { t } = useTranslation();
	const [activeTab, setActiveTab] = useState<"text" | "embedding">(initialRole);
	const [searchTerm, setSearchTerm] = useState("");

	useEffect(() => {
		if (fixedRole) {
			setActiveTab(fixedRole);
			return;
		}
		setActiveTab(initialRole);
	}, [fixedRole, initialRole]);

	if (!isOpen) return null;

	const currentRole = fixedRole || activeTab;
	const filteredModels = models.filter((m) => {
		if (m.role !== currentRole) return false;
		if (searchTerm) {
			const search = searchTerm.toLowerCase();
			return (
				m.display_name.toLowerCase().includes(search) ||
				(m.filename && m.filename.toLowerCase().includes(search))
			);
		}
		return true;
	});

	const handleSelect = (modelId: string) => {
		onSelect(modelId);
		onClose();
	};

	return createPortal(
		<div
			className="fixed inset-0 z-[300] flex justify-end bg-black/60 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-labelledby="model-selection-overlay-title"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div className="bg-[#1a1a1a] w-full max-w-lg h-full flex flex-col shadow-[-10px_0_30px_rgba(0,0,0,0.5)] animate-in slide-in-from-right duration-300 border-l border-white/10">
				<div className="flex items-center justify-between p-6 border-b border-white/5 bg-white/[0.02]">
					<h3 id="model-selection-overlay-title" className="flex items-center gap-3 min-w-0 flex-1">
						<List size={22} className="text-gold-400" />
						<div className="min-w-0 h-7 flex items-center">
							<FitText className="text-xl font-medium text-white" minFontSize={14} maxFontSize={20}>
								{t("settings.sections.models.selection.select_model", "Select a Model")}
							</FitText>
						</div>
					</h3>
					<div className="flex items-center gap-3">
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

				<div className="px-6 py-4 border-b border-white/5 bg-black/10">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
						<input
							type="text"
							placeholder={t("common.search", "Search...")}
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-4 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/50 focus:border-gold-400/50 transition-colors"
						/>
					</div>
				</div>

				<div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar bg-black/20">
					{/* Add "Global Default" option if appropriate? Usually we handle that at call site, but let's keep it simple here. */}

					{filteredModels.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-40 text-gray-500 gap-3">
							<List size={32} className="opacity-20" />
							<span>{t("settings.sections.models.no_models_for_role") || "No models found."}</span>
						</div>
					) : (
						filteredModels.map((model) => {
							const isSelected = selectedModelId === model.id;
							return (
								<button
									type="button"
									key={model.id}
									onClick={() => handleSelect(model.id)}
									className={`w-full text-left p-4 rounded-xl flex items-center justify-between group transition-all border ${isSelected
										? "bg-gold-500/10 border-gold-500/30"
										: "bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/20"
										}`}
								>
									<div className="flex items-center gap-4 flex-1 min-w-0">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 mb-1">
												<div className={`font-medium truncate text-sm sm:text-base ${isSelected ? "text-gold-200" : "text-white"}`}>
													{model.display_name}
												</div>
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

									{isSelected && (
										<div className="shrink-0 ml-4 text-gold-400">
											<CheckCircle size={20} />
										</div>
									)}
								</button>
							);
						})
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
};
