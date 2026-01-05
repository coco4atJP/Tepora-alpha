import { Sliders, X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { createPortal } from "react-dom";
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
	const [showAdvanced, setShowAdvanced] = useState(false);

	if (!isOpen) return null;
	if (!config) return null;

	const update = <K extends keyof ModelConfig>(f: K, v: ModelConfig[K]) =>
		onChange({ ...config, [f]: v });

	return createPortal(
		<div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
			<div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
				<div className="flex items-center justify-between p-6 border-b border-white/5 bg-white/5">
					<h3 className="text-lg font-medium text-white flex items-center gap-2">
						<Sliders size={20} className="text-purple-400" />
						{title}
					</h3>
					<button
						onClick={onClose}
						className="text-gray-400 hover:text-white transition-colors"
					>
						<X size={20} />
					</button>
				</div>

				<div className="p-6 space-y-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
					{/* Primary Settings */}
					<div className="space-y-6">
						<div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 text-xs text-purple-200 flex items-center gap-2">
							<Sliders size={14} />
							Changes to model parameters will apply on next load.
						</div>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
							{!isEmbedding && (
								<>
									<FormGroup
										label="Temperature"
										description="Controls randomness."
									>
										<div className="flex items-center gap-4">
											<input
												type="range"
												min="0"
												max="2"
												step="0.1"
												value={config.temperature ?? 0.7}
												onChange={(e) =>
													update("temperature", parseFloat(e.target.value))
												}
												className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
											/>
											<FormInput
												type="number"
												value={config.temperature ?? 0.7}
												onChange={(v) => update("temperature", v as number)}
												step={0.1}
												className="w-20 text-center"
											/>
										</div>
									</FormGroup>
									<FormGroup label="Top P" description="Nucleus sampling.">
										<div className="flex items-center gap-4">
											<input
												type="range"
												min="0"
												max="1"
												step="0.05"
												value={config.top_p ?? 0.9}
												onChange={(e) =>
													update("top_p", parseFloat(e.target.value))
												}
												className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
											/>
											<FormInput
												type="number"
												value={config.top_p ?? 0.9}
												onChange={(v) => update("top_p", v as number)}
												step={0.05}
												className="w-20 text-center"
											/>
										</div>
									</FormGroup>
								</>
							)}
							<div className="col-span-1 md:col-span-2">
								<FormGroup
									label="Context Window (n_ctx)"
									description="Maximum number of tokens the model can process at once."
								>
									<FormInput
										type="number"
										value={config.n_ctx}
										onChange={(v) => update("n_ctx", v as number)}
										step={512}
									/>
								</FormGroup>
							</div>
						</div>
					</div>

					{/* Advanced Toggle */}
					<div className="border-t border-white/5 pt-6">
						<button
							onClick={() => setShowAdvanced(!showAdvanced)}
							className="w-full py-2 text-xs font-semibold text-gray-500 hover:text-gray-300 uppercase tracking-wider flex items-center justify-center gap-2 transition-colors"
						>
							{showAdvanced
								? "Hide Advanced Settings"
								: "Show Advanced Settings"}
						</button>

						{/* Advanced Settings */}
						{showAdvanced && (
							<div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in slide-in-from-top-2">
								<FormGroup label="GPU Layers (-1 for all)">
									<FormInput
										type="number"
										value={config.n_gpu_layers}
										onChange={(v) => update("n_gpu_layers", v as number)}
										min={-1}
									/>
								</FormGroup>
								<FormGroup label="Port">
									<FormInput
										type="number"
										value={config.port}
										onChange={(v) => update("port", v as number)}
									/>
								</FormGroup>
								<div className="col-span-1 md:col-span-2">
									<FormGroup label="File Path (Read-only)">
										<FormInput
											value={config.path}
											onChange={() => {}}
											disabled
											className="opacity-50 font-mono text-xs bg-black/40"
										/>
									</FormGroup>
								</div>
							</div>
						)}
					</div>
				</div>

				<div className="p-4 border-t border-white/5 bg-black/20 text-right">
					<button
						onClick={onClose}
						className="px-6 py-2 bg-white text-black font-medium rounded-lg hover:bg-gray-200 transition-colors"
					>
						Done
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
};
