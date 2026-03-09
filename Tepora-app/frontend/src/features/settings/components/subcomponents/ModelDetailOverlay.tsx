import { Sliders, X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { DialControl } from "../../../../components/ui/DialControl";
import { FormGroup, FormInput } from "../SettingsComponents";

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
	max_tokens?: number;
	predict_len?: number;
}

interface ModelDetailOverlayProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	config: ModelConfig;
	onChange: (config: ModelConfig) => void;
	isEmbedding?: boolean;
}

export const ModelDetailOverlay: React.FC<ModelDetailOverlayProps> = ({
	isOpen,
	onClose,
	title,
	config,
	onChange,
	isEmbedding,
}) => {
	const { t } = useTranslation();
	const [showAdvanced, setShowAdvanced] = useState(false);

	if (!isOpen) return null;
	if (!config) return null;

	const update = <K extends keyof ModelConfig>(f: K, v: ModelConfig[K]) =>
		onChange({ ...config, [f]: v });

	return createPortal(
		<div
			className="fixed inset-0 z-[250] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby="model-detail-overlay-title"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div className="bg-[#0A0A0C] border border-white/10 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
				{/* Header */}
				<div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-white/[0.02]">
					<h3 id="model-detail-overlay-title" className="flex items-center gap-3 min-w-0 flex-1">
						<div className="w-8 h-8 rounded-lg bg-tea-500/10 border border-tea-500/20 flex items-center justify-center">
							<Sliders size={16} className="text-tea-400" />
						</div>
						<div className="min-w-0 flex items-center">
							<span className="text-base font-semibold text-white/90 tracking-wide truncate">
								{title}
							</span>
						</div>
					</h3>
					<button
						type="button"
						onClick={onClose}
						className="p-2 text-white/40 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
						aria-label={t("common.aria.close")}
					>
						<X size={20} />
					</button>
				</div>

				<div className="p-6 md:p-8 space-y-8 max-h-[75vh] overflow-y-auto custom-scrollbar">
					{/* Primary Settings (Dials) */}
					{!isEmbedding && (
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<h4 className="text-sm font-semibold text-white/80 tracking-wide">{t("settings.sections.models.detail.generation_params", "Generation Parameters")}</h4>
							</div>

							<div className="p-6 bg-black/40 rounded-xl border border-white/5">
								<div className="flex flex-wrap justify-center gap-10 md:gap-16">
									<DialControl
										label={t("settings.models_settings.configurations.temp") || "Temperature"}
										value={config.temperature ?? 0.7}
										min={0}
										max={2.0}
										step={0.1}
										onChange={(v) => update("temperature", v)}
										size={100}
									/>

									<DialControl
										label={t("settings.models_settings.configurations.top_p") || "Top P"}
										value={config.top_p ?? 0.9}
										min={0}
										max={1.0}
										step={0.05}
										onChange={(v) => update("top_p", v)}
										size={100}
									/>

									<DialControl
										label={
											t("settings.models_settings.configurations.repeat_penalty") || "Repeat Penalty"
										}
										value={config.repeat_penalty ?? 1.1}
										min={1.0}
										max={2.0}
										step={0.05}
										onChange={(v) => update("repeat_penalty", v)}
										size={100}
									/>

									<DialControl
										label={t("settings.models_settings.configurations.top_k") || "Top K"}
										value={config.top_k ?? 40}
										min={1}
										max={100}
										step={1}
										onChange={(v) => update("top_k", v)}
										size={100}
									/>
								</div>

								<div className="flex items-center justify-center gap-2 mt-8 text-xs text-white/30 font-medium">
									<span className="w-1.5 h-1.5 rounded-full bg-white/20"></span>
									{t("settings.sections.models.detail.dials_hint", "Drag dials to adjust or click value to type")}
									<span className="w-1.5 h-1.5 rounded-full bg-white/20"></span>
								</div>
							</div>
						</div>
					)}

					{/* Context Window */}
					<div className="space-y-4">
						<h4 className="text-sm font-semibold text-white/80 tracking-wide">{t("settings.sections.models.detail.system_params", "System Parameters")}</h4>
						<div className="p-5 bg-black/40 rounded-xl border border-white/5">
							<FormGroup
								label={t("settings.sections.models.detail.n_ctx") || "Context Window (n_ctx)"}
								description={
									t("settings.sections.models.detail.n_ctx_desc") ||
									"Maximum number of tokens the model can process at once."
								}
							>
								<div className="flex gap-4 items-center">
									<input
										type="range"
										min="2048"
										max="32768"
										step="1024"
										value={config.n_ctx}
										onChange={(e) => update("n_ctx", parseInt(e.target.value, 10))}
										className="flex-1 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-tea-500 hover:accent-tea-400 transition-colors"
									/>
									<FormInput
										type="number"
										value={config.n_ctx}
										onChange={(v) => update("n_ctx", v as number)}
										step={1024}
										className="w-24 text-center font-mono text-sm"
									/>
								</div>
							</FormGroup>
						</div>
					</div>

					{/* Advanced Toggle */}
					<div className="pt-2">
						<button
							type="button"
							onClick={() => setShowAdvanced(!showAdvanced)}
							className="w-full py-3 px-4 rounded-xl text-xs font-semibold text-white/50 hover:text-white/90 hover:bg-white/[0.02] uppercase tracking-widest flex items-center justify-between transition-all border border-transparent hover:border-white/5"
						>
							<span>{showAdvanced
								? t("settings.sections.models.detail.hide_advanced", "Hide Advanced Settings")
								: t("settings.sections.models.detail.show_advanced", "Show Advanced Settings")}</span>
							<span className="text-[10px]">&gt;</span>
						</button>

						{/* Advanced Settings */}
						{showAdvanced && (
							<div className="mt-4 p-5 md:p-6 bg-black/40 rounded-xl border border-white/5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 animate-in fade-in slide-in-from-top-2">
								<FormGroup
									label={
										t("settings.models_settings.configurations.gpu_layers") ||
										"GPU Layers (-1 for all)"
									}
								>
									<FormInput
										type="number"
										value={config.n_gpu_layers}
										onChange={(v) => update("n_gpu_layers", v as number)}
										min={-1}
									/>
								</FormGroup>
								<FormGroup label={t("settings.models_settings.configurations.port") || "Port"}>
									<FormInput
										type="number"
										value={config.port}
										onChange={(v) => update("port", v as number)}
									/>
								</FormGroup>
								<FormGroup
									label={t("settings.models_settings.configurations.max_tokens", "Max Tokens")}
									description={t("settings.models_settings.configurations.max_tokens_desc", "Maximum number of tokens to generate per response.")}
								>
									<FormInput
										type="number"
										value={config.max_tokens ?? 0}
										onChange={(v) => update("max_tokens", v as number)}
										min={0}
										max={32768}
										step={64}
									/>
								</FormGroup>
								<FormGroup
									label={t("settings.models_settings.configurations.predict_len", "Predict Length")}
									description={t("settings.models_settings.configurations.predict_len_desc", "Prediction length hint for the model server (0 = auto).")}
								>
									<FormInput
										type="number"
										value={config.predict_len ?? 0}
										onChange={(v) => update("predict_len", v as number)}
										min={0}
										max={32768}
										step={64}
									/>
								</FormGroup>
								<div className="col-span-1 md:col-span-2 mt-2">
									<FormGroup
										label={
											t("settings.models_settings.configurations.path", "File Path (Read-only)")
										}
									>
										<FormInput
											value={config.path}
											onChange={() => { }}
											disabled
											className="opacity-50 font-mono text-xs bg-black/60 border-white/5 cursor-default"
										/>
									</FormGroup>
								</div>
							</div>
						)}
					</div>
				</div>

				{/* Footer */}
				<div className="px-6 py-4 border-t border-white/5 bg-black/40 flex items-center justify-between">
					<div className="text-xs text-white/40 flex items-center gap-2">
						<Sliders size={12} />
						{t("settings.sections.models.detail.changes_note", "Changes apply on next load")}
					</div>
					<button
						type="button"
						onClick={onClose}
						className="px-6 py-2 bg-white/10 hover:bg-white/20 text-white font-medium text-sm rounded-lg transition-colors border border-white/10"
					>
						{t("common.close") || "Done"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
};
