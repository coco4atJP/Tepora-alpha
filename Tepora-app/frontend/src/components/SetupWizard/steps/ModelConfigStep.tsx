import {
	CheckCircle,
	CheckSquare,
	ChevronRight,
	Cpu,
	Download,
	Globe,
	HardDrive,
	Settings,
	Square,
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
			<div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 flex gap-3">
				<HardDrive className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
				<div className="text-sm text-blue-200">
					<p className="font-medium mb-1">
						{t("setup.storage_required", "Approx. 2GB+ per model required")}
					</p>
					<p className="opacity-80">
						{t(
							"setup.storage_desc",
							"Tepora runs locally. Models will be stored in your AppData folder.",
						)}
					</p>
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
		<div className="space-y-4">
			<div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
				<div className="text-sm font-medium text-gray-300 mb-2">
					Select Models to Install:
				</div>
				{state.defaults?.text_models.map((m) => {
					const key = getKey(m);
					const isSelected = state.selectedModels.has(key);
					return (
						<div
							key={key}
							className={`flex items-start gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
								isSelected
									? "bg-gold-400/10 border-gold-400/30"
									: "bg-black/20 border-transparent hover:bg-white/5"
							}`}
							onClick={() => dispatch({ type: "TOGGLE_MODEL", payload: key })}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									dispatch({ type: "TOGGLE_MODEL", payload: key });
								}
							}}
							role="button"
							tabIndex={0}
						>
							{isSelected ? (
								<CheckSquare className="w-5 h-5 text-gold-400 shrink-0 mt-0.5" />
							) : (
								<Square className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
							)}
							<div>
								<div
									className={`font-medium ${isSelected ? "text-gold-100" : "text-gray-400"}`}
								>
									{m.display_name}
								</div>
								<div className="text-xs text-gray-500 break-all">
									{m.repo_id}
								</div>
							</div>
						</div>
					);
				})}
				{state.defaults?.text_models.length === 0 && (
					<div className="text-gray-500 text-sm italic">Loading models...</div>
				)}
			</div>

			<button
				type="button"
				onClick={onStartSetup}
				disabled={state.selectedModels.size === 0}
				className="w-full text-left p-6 bg-gradient-to-br from-coffee-900/40 to-black/60 border border-gold-500/20 hover:border-gold-500/50 rounded-xl group transition-all duration-300 shadow-lg hover:shadow-gold-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<div className="flex items-center justify-between mb-2">
					<div className="flex items-center gap-2">
						<CheckCircle className="w-5 h-5 text-green-400" />
						<span className="font-semibold text-lg text-gold-100">
							{t("setup.install_selected", "Install Selected Models")}
						</span>
					</div>
					<ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-gold-400" />
				</div>
				<p className="text-sm text-gray-400 pl-7">
					{state.selectedModels.size} models selected.
				</p>
			</button>

			<button
				type="button"
				onClick={onShowAdvanced}
				className="w-full text-left p-4 bg-white/5 border border-white/5 hover:border-white/20 rounded-lg group transition-all"
			>
				<div className="flex items-center justify-between mb-2">
					<div className="flex items-center gap-2">
						<Settings className="w-5 h-5 text-gray-400" />
						<span className="font-semibold text-lg text-gray-200">
							{t("setup.custom", "Custom Configuration (Advanced)")}
						</span>
					</div>
					<ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-white" />
				</div>
				<p className="text-sm text-gray-500 pl-7">
					{t(
						"setup.custom_desc",
						"Specify your own GGUF model repositories and filenames.",
					)}
				</p>
			</button>
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
					<label className="text-sm font-medium text-gray-300 capitalize flex items-center gap-2">
						{role === "text" ? (
							<Cpu className="w-4 h-4" />
						) : (
							<Globe className="w-4 h-4" />
						)}
						{role} Model
					</label>
					<div className="grid grid-cols-2 gap-3">
						<input
							placeholder="Repo ID (e.g. user/repo)"
							className="glass-input text-sm w-full"
							value={state.customModels?.[role]?.repo_id || ""}
							onChange={(e) =>
								handleInputChange(role, "repo_id", e.target.value)
							}
						/>
						<input
							placeholder="Filename (e.g. model.gguf)"
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
