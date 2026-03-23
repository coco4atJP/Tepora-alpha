import { Sliders } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import type { SetupModel } from "../../../../shared/contracts";
import { Modal } from "../../../../shared/ui";
import { useSettingsEditor } from "../../model/editor";

interface ModelSettingsModalProps {
	model: SetupModel | null;
	isOpen: boolean;
	onClose: () => void;
}

export const ModelSettingsModal: React.FC<ModelSettingsModalProps> = ({
	model,
	isOpen,
	onClose,
}) => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();

	if (!model) return null;

	const isEmbedding = model.role === "embedding";
	const basePath = `models.${model.id}`;

	const readParam = (key: string, fallback: number) =>
		editor.readNumber(`${basePath}.${key}`, fallback);
	const writeParam = (key: string, value: number) =>
		editor.updateField(`${basePath}.${key}`, value);

	return (
		<Modal
			isOpen={isOpen}
			onClose={onClose}
			title={`${model.display_name} ${t("common.settings", "Settings")}`}
			size="md"
		>
			<div className="space-y-6">
				{/* Generation Parameters (text models only) */}
				{!isEmbedding && (
					<div className="space-y-4">
						<h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-text-muted border-b border-border/30 pb-2">
							<Sliders size={14} />
							{t("settings.sections.models.detail.generation_params", "Generation Parameters")}
						</h4>
						<div className="grid grid-cols-2 gap-4">
							<ParamSlider
								label={t("settings.models_settings.configurations.temp", "Temperature")}
								value={readParam("temperature", 0.7)}
								min={0}
								max={2.0}
								step={0.1}
								onChange={(v) => writeParam("temperature", v)}
							/>
							<ParamSlider
								label={t("settings.models_settings.configurations.top_p", "Top P")}
								value={readParam("top_p", 0.9)}
								min={0}
								max={1.0}
								step={0.05}
								onChange={(v) => writeParam("top_p", v)}
							/>
							<ParamSlider
								label={t("settings.models_settings.configurations.repeat_penalty", "Repeat Penalty")}
								value={readParam("repeat_penalty", 1.1)}
								min={1.0}
								max={2.0}
								step={0.05}
								onChange={(v) => writeParam("repeat_penalty", v)}
							/>
							<ParamSlider
								label={t("settings.models_settings.configurations.top_k", "Top K")}
								value={readParam("top_k", 40)}
								min={1}
								max={100}
								step={1}
								onChange={(v) => writeParam("top_k", v)}
							/>
						</div>
					</div>
				)}

				{/* System Parameters */}
				<div className="space-y-4">
					<h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-text-muted border-b border-border/30 pb-2">
						{t("settings.sections.models.detail.system_params", "System Parameters")}
					</h4>
					<div className="grid grid-cols-2 gap-4">
						<ParamSlider
							label={t("settings.sections.models.detail.n_ctx", "Context Window (n_ctx)")}
							value={readParam("n_ctx", isEmbedding ? 2048 : 4096)}
							min={512}
							max={32768}
							step={512}
							onChange={(v) => writeParam("n_ctx", v)}
						/>
						<ParamSlider
							label={t("settings.models_settings.configurations.gpu_layers", "GPU Layers (-1 for all)")}
							value={readParam("n_gpu_layers", -1)}
							min={-1}
							max={128}
							step={1}
							onChange={(v) => writeParam("n_gpu_layers", v)}
						/>
					</div>
				</div>

				<div className="pt-4 flex items-center justify-between border-t border-border/40">
					<p className="text-[11px] text-text-muted/70 font-medium tracking-wide">
						{t("settings.sections.models.detail.changes_note", "Changes apply on next load")}
					</p>
				</div>
			</div>
		</Modal>
	);
};

/* ── Compact Parameter Slider ── */

interface ParamSliderProps {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
}

const ParamSlider: React.FC<ParamSliderProps> = ({
	label,
	value,
	min,
	max,
	step,
	onChange,
}) => {
	const displayValue = step < 1 ? value.toFixed(2) : String(value);

	return (
		<div className="rounded-xl bg-surface-alt/40 border border-border/40 px-3 py-3 space-y-2">
			<div className="flex items-center justify-between">
				<span className="text-[11px] font-semibold uppercase tracking-widest text-text-muted" title={label}>
					{label.length > 20 ? `${label.substring(0, 18)}...` : label}
				</span>
				<span className="text-[13px] font-mono font-bold text-primary tabular-nums">
					{displayValue}
				</span>
			</div>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(parseFloat(e.target.value))}
				className="w-full h-1.5 bg-border/60 rounded-lg appearance-none cursor-pointer accent-primary hover:accent-primary/80 transition-colors"
			/>
		</div>
	);
};
