import { ChevronDown } from "lucide-react";
import type React from "react";
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ModelSelectionOverlay, type ModelInfo } from "./ModelSelectionOverlay";
import { modelsApi } from "../../../../api/models";
import { logger } from "../../../../../utils/logger";

interface ModelSelectorProps {
	value: string | undefined;
	onChange: (modelId: string) => void;
	role?: "text" | "embedding";
	placeholder?: string;
	className?: string;
	disabled?: boolean;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
	value,
	onChange,
	role = "text",
	placeholder,
	className,
	disabled = false,
}) => {
	const { t } = useTranslation();
	const [isOpen, setIsOpen] = useState(false);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [isLoading, setIsLoading] = useState(false);

	const fetchModels = useCallback(async () => {
		setIsLoading(true);
		try {
			const data = await modelsApi.list();
			setModels(data.models || []);
		} catch (e) {
			logger.error("Failed to fetch models", e);
		} finally {
			setIsLoading(false);
		}
	}, []);

	// Fetch models when opening if not already fetched
	const handleOpen = () => {
		if (disabled) return;
		if (models.length === 0) {
			fetchModels();
		}
		setIsOpen(true);
	};

	// We might need to fetch initially just to resolve the display name of the selected value
	useEffect(() => {
		if (value && models.length === 0) {
			fetchModels();
		}
	}, [value, models.length, fetchModels]);

	const selectedModel = models.find((m) => m.id === value);
	const displayText = selectedModel
		? selectedModel.display_name
		: value
			? value // Fallback to ID if model not found yet
			: (placeholder || t("settings.sections.models.selection.select_model", "Select a model..."));

	return (
		<>
			<button
				type="button"
				onClick={handleOpen}
				disabled={disabled}
				className={`flex items-center justify-between w-full appearance-none bg-white/5 border border-white/10 hover:border-white/20 rounded-xl px-4 py-2.5 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/50 focus:border-gold-400/50 ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className || ""}`}
			>
				<span className={selectedModel ? "text-white truncate" : "text-gray-400 truncate"}>
					{isLoading && !selectedModel && value ? t("common.loading", "Loading...") : displayText}
				</span>
				<ChevronDown size={16} className="text-gray-400 shrink-0 ml-2" />
			</button>

			<ModelSelectionOverlay
				isOpen={isOpen}
				onClose={() => setIsOpen(false)}
				models={models}
				onSelect={onChange}
				selectedModelId={value}
				fixedRole={role}
			/>
		</>
	);
};

