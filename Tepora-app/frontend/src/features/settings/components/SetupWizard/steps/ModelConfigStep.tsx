import {
	CheckCircle,
	ChevronRight,
	Cpu,
	Download,
	Globe,
	HardDrive,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { getKey } from "../reducer";
import type { ModelConfigStepProps } from "../types";

export default function ModelConfigStep({
	state,
	dispatch,
	showAdvanced,
	setShowAdvanced,
	onStartSetup,
}: ModelConfigStepProps) {
	const { t } = useTranslation();
	return (
		<div className="space-y-6">
			{/* Storage Info */}
			{/* Storage Info */}
			<div className="bg-blue-900/10 border border-blue-500/20 rounded-lg p-3 flex gap-3 text-xs text-blue-200/80 mb-2">
				<HardDrive className="w-4 h-4 shrink-0 mt-0.5" />
				<div>
					<span className="font-medium text-blue-200">
						{t("setup.storage_requirement_label")}
					</span>{" "}
					{t("setup.storage_requirement_hint")}
				</div>
			</div>

			{!showAdvanced ? (
				<DefaultModelSelection
					state={state}
					dispatch={dispatch}
					onStartSetup={onStartSetup}
					onShowAdvanced={() => setShowAdvanced(true)}
				/>
			) : (
				<AdvancedModelSelection
					state={state}
					dispatch={dispatch}
					onStartSetup={onStartSetup}
					onBack={() => setShowAdvanced(false)}
				/>
			)}
		</div>
	);
}

// Sub-components for better organization
interface DefaultModelSelectionProps {
	state: ModelConfigStepProps["state"];
	dispatch: ModelConfigStepProps["dispatch"];
	onStartSetup: () => void;
	onShowAdvanced: () => void;
}

function DefaultModelSelection({
	state,
	dispatch,
	onStartSetup,
	onShowAdvanced,
}: DefaultModelSelectionProps) {
	const { t } = useTranslation();

	return (
		<div className="space-y-8 animate-slide-up">
			{/* Model Cards */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				{state.defaults?.text_models.map((m) => {
					const key = getKey(m);
					const isSelected = state.selectedModels.has(key);
					return (
						<button
							type="button"
							key={key}
							className={`setup-card relative cursor-pointer group flex flex-col h-full ${isSelected ? "active border-gold-500/50" : "opacity-80 hover:opacity-100"}`}
							onClick={() => dispatch({ type: "TOGGLE_MODEL", payload: key })}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									dispatch({ type: "TOGGLE_MODEL", payload: key });
								}
							}}
							aria-pressed={isSelected}
						>
							<div className="absolute top-4 right-4 z-10">
								{isSelected ? (
									<CheckCircle className="w-6 h-6 text-gold-400 fill-gold-400/10" />
								) : (
									<div className="w-6 h-6 rounded-full border-2 border-white/20 group-hover:border-white/40" />
								)}
							</div>

							<div className="mb-4">
								<div className="w-10 h-10 rounded-lg bg-gradient-to-br from-gray-800 to-black border border-white/10 flex items-center justify-center mb-3 group-hover:shadow-glow transition-shadow">
									<Cpu
										className={`w-5 h-5 ${isSelected ? "text-gold-400" : "text-gray-400"}`}
									/>
								</div>
								<div
									className={`font-display text-lg font-bold mb-1 line-clamp-2 ${isSelected ? "text-gold-100" : "text-gray-300"}`}
								>
									{m.display_name}
								</div>
								<div className="text-xs text-gray-500 break-all font-mono opacity-70">
									{m.repo_id}
								</div>
							</div>

							<div className="mt-auto pt-4 border-t border-white/5">
								<span className="text-xs text-gray-400 flex items-center gap-1">
									<HardDrive className="w-3 h-3" />
									{t("setup.approx_vram")}
								</span>
							</div>
						</button>
					);
				})}
				{state.defaults?.text_models.length === 0 && (
					<div className="col-span-2 text-center py-12 text-gray-500 italic border border-dashed border-white/10 rounded-xl">
						{t("setup.loading_recommendations")}
					</div>
				)}
			</div>

			{/* Action Area */}
			<div className="space-y-4 pt-4">
				<button
					type="button"
					onClick={onStartSetup}
					disabled={state.selectedModels.size === 0}
					className="w-full relative overflow-hidden group p-4 rounded-xl bg-gold-400 text-black font-bold shadow-lg shadow-gold-900/20 hover:bg-gold-300 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
				>
					<div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
					<div className="relative flex items-center justify-center gap-3">
						<Download className="w-5 h-5" />
						<span className="text-lg tracking-wide">
							{t("setup.install_selected", "Install Selected Models")}
						</span>
						<ChevronRight className="w-5 h-5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
					</div>
				</button>

				{state.selectedModels.size > 0 && (
					<div className="text-center">
						<span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300">
							<CheckCircle className="w-3 h-3" />
							{state.selectedModels.size} models selected
						</span>
					</div>
				)}

				<button
					type="button"
					onClick={onShowAdvanced}
					className="w-full text-center text-xs text-gray-500 hover:text-white transition-colors py-2"
				>
					{t("setup.custom", "Configure custom models instead")}
				</button>
			</div>
		</div>
	);
}

interface AdvancedModelSelectionProps {
	state: ModelConfigStepProps["state"];
	dispatch: ModelConfigStepProps["dispatch"];
	onStartSetup: () => void;
	onBack: () => void;
}

function AdvancedModelSelection({
	state,
	dispatch,
	onStartSetup,
	onBack,
}: AdvancedModelSelectionProps) {
	const { t } = useTranslation();

	const handleInputChange = (
		role: "text" | "embedding",
		field: "repo_id" | "filename",
		value: string,
	) => {
		const currentModel = state.customModels?.[role];
		dispatch({
			type: "SET_CUSTOM_MODELS",
			payload: {
				...state.customModels,
				[role]: {
					...currentModel,
					[field]: value,
					display_name: "Custom Model",
					repo_id: field === "repo_id" ? value : currentModel?.repo_id || "",
					filename: field === "filename" ? value : currentModel?.filename || "",
				},
			},
		});
	};

	return (
		<div className="space-y-6 animate-in slide-in-from-right-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-medium text-white">
					{t("setup.custom_models", "Custom Models")}
				</h3>
				<button
					type="button"
					onClick={onBack}
					className="text-xs text-gold-400 hover:underline"
				>
					{t("common.back", "Back to Recommendations")}
				</button>
			</div>

			{(["text", "embedding"] as const).map((role) => (
				<div key={role} className="space-y-2">
					<label htmlFor={`model-${role}-repo`} className="text-sm font-medium text-gray-300 capitalize flex items-center gap-2">
						{role === "text" ? (
							<Cpu className="w-4 h-4" />
						) : (
							<Globe className="w-4 h-4" />
						)}
						{role === "text"
							? t("setup.model_role_text")
							: t("setup.model_role_embedding")}
					</label>
					<div className="grid grid-cols-2 gap-3">
						<input
							id={`model-${role}-repo`}
							placeholder={t("setup.custom_repo_placeholder")}
							className="glass-input text-sm w-full"
							value={state.customModels?.[role]?.repo_id || ""}
							onChange={(e) =>
								handleInputChange(role, "repo_id", e.target.value)
							}
						/>
						<input
							aria-label={t("setup.custom_filename_placeholder")}
							placeholder={t("setup.custom_filename_placeholder")}
							className="glass-input text-sm w-full"
							value={state.customModels?.[role]?.filename || ""}
							onChange={(e) =>
								handleInputChange(role, "filename", e.target.value)
							}
						/>
					</div>
				</div>
			))}

			<button
				type="button"
				onClick={onStartSetup}
				className="w-full py-3 bg-gold-500 hover:bg-gold-400 text-black font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
			>
				<Download className="w-4 h-4" />
				{t("setup.start_install", "Start Installation")}
			</button>
		</div>
	);
}
