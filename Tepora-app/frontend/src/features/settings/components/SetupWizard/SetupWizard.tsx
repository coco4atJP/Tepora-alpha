import { useCallback, useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRequirements } from "../../../../hooks/useServerConfig";
import { ApiError, apiClient } from "../../../../utils/api-client";
import { getKey, initialState, setupReducer } from "./reducer";
import {
	CompleteStep,
	ErrorStep,
	InstallingStep,
	LanguageStep,
	ModelConfigStep,
	RequirementsCheckStep,
} from "./steps";
import type { DefaultModelsResponse, ProgressState, SetupStep } from "./types";

interface SetupWizardProps {
	onComplete: () => void;
	onSkip?: () => void;
}

export default function SetupWizard({ onComplete, onSkip }: SetupWizardProps) {
	const { t, i18n } = useTranslation();
	const [state, dispatch] = useReducer(setupReducer, initialState);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const { refetch: refetchRequirements } = useRequirements();
	const [pendingConsent, setPendingConsent] = useState<{
		targetModels: Array<{
			repo_id: string;
			filename: string;
			display_name: string;
			role: string;
		}>;
		warnings: Array<{
			repo_id: string;
			filename: string;
			warnings: string[];
		}>;
	} | null>(null);

	// --- Actions ---

	const checkRequirements = useCallback(async () => {
		dispatch({ type: "REQ_CHECK_START" });
		try {
			const result = await refetchRequirements();
			if (result.error || !result.data) {
				throw new Error(
					t("setup.errors.req_check_failed", "Requirements check failed"),
				);
			}
			const data = result.data;
			dispatch({ type: "REQ_CHECK_SUCCESS", payload: data });
		} catch (err) {
			dispatch({
				type: "REQ_CHECK_FAILURE",
				payload:
					err instanceof Error
						? err.message
						: t("setup.errors.unknown", "Unknown error"),
			});
		}
	}, [refetchRequirements, t]);

	const handleSelectLanguage = async (lang: string) => {
		try {
			await i18n.changeLanguage(lang);
			dispatch({ type: "SET_LANGUAGE", payload: lang });

			await apiClient.post("api/setup/init", { language: lang });

			checkRequirements();
		} catch (err) {
			console.error("Language set failed", err);
			dispatch({ type: "REQ_CHECK_START" });
		}
	};

	const runSetup = async (
		target_models: Array<{
			repo_id: string;
			filename: string;
			display_name: string;
			role: string;
		}>,
		acknowledge_warnings: boolean,
	) => {
		try {
			const data = await apiClient.post<{
				success?: boolean;
				job_id?: string;
				error?: string;
				requires_consent?: boolean;
				warnings?: Array<{
					repo_id: string;
					filename: string;
					warnings: string[];
				}>;
			}>("api/setup/run", {
				target_models,
				acknowledge_warnings,
			});

			if (data.success) {
				dispatch({ type: "START_INSTALL", payload: data.job_id || "" });
			} else {
				throw new Error(
					data.error ||
						t("setup.errors.setup_failed_start", "Setup failed to start"),
				);
			}
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				const data = err.data as {
					requires_consent?: boolean;
					warnings?: Array<{
						repo_id: string;
						filename: string;
						warnings: string[];
					}>;
				};
				if (data?.requires_consent) {
					setPendingConsent({
						targetModels: target_models,
						warnings: data.warnings || [],
					});
					return;
				}
			}

			const errorMessage =
				err instanceof ApiError
					? (err.data as { error?: string })?.error || err.message
					: err instanceof Error
						? err.message
						: t("setup.errors.start_failed", "Failed to start setup");
			throw new Error(errorMessage);
		}
	};

	const handleStartSetup = async () => {
		try {
			const target_models: Array<{
				repo_id: string;
				filename: string;
				display_name: string;
				role: string;
			}> = [];

			if (showAdvanced && state.customModels) {
				if (state.customModels.text) {
					target_models.push({
						repo_id: state.customModels.text.repo_id,
						filename: state.customModels.text.filename,
						display_name: state.customModels.text.display_name,
						role: "text",
					});
				}
				if (state.customModels.embedding) {
					target_models.push({
						repo_id: state.customModels.embedding.repo_id,
						filename: state.customModels.embedding.filename,
						display_name: state.customModels.embedding.display_name,
						role: "embedding",
					});
				}
			} else if (state.defaults) {
				state.defaults.text_models.forEach((m) => {
					if (state.selectedModels.has(getKey(m))) {
						target_models.push({
							repo_id: m.repo_id,
							filename: m.filename,
							display_name: m.display_name,
							role: "text",
						});
					}
				});

				if (state.defaults.embedding) {
					target_models.push({
						repo_id: state.defaults.embedding.repo_id,
						filename: state.defaults.embedding.filename,
						display_name: state.defaults.embedding.display_name,
						role: "embedding",
					});
				}
			}

			setPendingConsent(null);
			await runSetup(target_models, false);
		} catch (err) {
			dispatch({
				type: "INSTALL_FAILURE",
				payload: err instanceof Error ? err.message : "Start failed",
			});
		}
	};

	const handleFinish = async () => {
		try {
			await apiClient.post("api/setup/finish", { launch: true });
			onComplete();
		} catch {
			dispatch({
				type: "INSTALL_FAILURE",
				payload: t(
					"setup.errors.save_config_failed",
					"Failed to save configuration. Please try again.",
				),
			});
		}
	};

	// --- Effects ---

	// Load defaults for config screen
	useEffect(() => {
		if (state.step === "MODEL_CONFIG" && !state.defaults) {
			apiClient
				.get<DefaultModelsResponse>("api/setup/default-models")
				.then((data) => {
					dispatch({ type: "SET_DEFAULTS", payload: data });
				})
				.catch(() => {});
		}
	}, [state.step, state.defaults]);

	// Poll progress while installing
	useEffect(() => {
		if (state.step !== "INSTALLING") return;

		const interval = setInterval(async () => {
			try {
				const data = await apiClient.get<ProgressState>("api/setup/progress");
				dispatch({ type: "UPDATE_PROGRESS", payload: data });

				if (data.status === "completed") {
					dispatch({ type: "INSTALL_SUCCESS" });
					clearInterval(interval);
				} else if (data.status === "failed") {
					dispatch({ type: "INSTALL_FAILURE", payload: data.message });
					clearInterval(interval);
				}
			} catch {
				// Ignore polling errors
			}
		}, 800);

		return () => clearInterval(interval);
	}, [state.step]);

	// --- Render ---

	const stepTitles: Record<SetupStep, string> = {
		LANGUAGE: t("setup.title", "Welcome to Tepora"),
		CHECK_REQUIREMENTS: t("setup.checking", "Checking System..."),
		MODEL_CONFIG: t("setup.model_settings", "Model Configuration"),
		INSTALLING: t("setup.downloading", "Installing Components..."),
		COMPLETE: t("setup.complete", "Setup Complete"),
		ERROR: t("setup.error", "Setup Error"),
	};

	const renderStep = () => {
		switch (state.step) {
			case "LANGUAGE":
				return <LanguageStep onSelectLanguage={handleSelectLanguage} />;
			case "CHECK_REQUIREMENTS":
				return <RequirementsCheckStep />;
			case "MODEL_CONFIG":
				return (
					<ModelConfigStep
						state={state}
						dispatch={dispatch}
						showAdvanced={showAdvanced}
						setShowAdvanced={setShowAdvanced}
						onStartSetup={handleStartSetup}
					/>
				);
			case "INSTALLING":
				return <InstallingStep progress={state.progress} />;
			case "COMPLETE":
				return <CompleteStep onFinish={handleFinish} />;
			case "ERROR":
				return (
					<ErrorStep
						error={state.error}
						onRetry={() => dispatch({ type: "RESET_ERROR" })}
						onSkip={onSkip}
					/>
				);
			default:
				return null;
		}
	};

	const renderProgressDots = () => {
		if (state.step === "CHECK_REQUIREMENTS") return null;

		const steps = [
			{ key: "LANGUAGE", label: t("setup.step_lang", "Language") },
			{ key: "MODEL_CONFIG", label: t("setup.step_model", "Model") },
			{ key: "INSTALLING", label: t("setup.step_install", "Install") },
			{ key: "COMPLETE", label: t("setup.step_done", "Complete") },
		] as const;

		const currentIdx = steps.findIndex((s) => s.key === state.step);
		// If current step is NOT in the list (e.g. ERROR), default to -1 or handle appropriately
		// However, looking at the code, ERROR is a step. We'll handle visual state below.

		return (
			<div className="w-full px-12 py-6">
				<div className="relative flex justify-between items-center">
					{/* Line Background */}
					<div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-0.5 bg-white/10" />

					{/* Active Line (Progress) - approximate width based on steps */}
					<div
						className="absolute left-0 top-1/2 -translate-y-1/2 h-0.5 bg-gold-400/50 transition-all duration-500 ease-out"
						style={{
							width: `${(Math.max(0, currentIdx) / (steps.length - 1)) * 100}%`,
						}}
					/>

					{steps.map((s, i) => {
						const isActive = i === currentIdx;
						const isDone = i < currentIdx;

						return (
							<div
								key={s.key}
								className="relative z-10 flex flex-col items-center gap-2 group"
							>
								<div
									className={`w-4 h-4 rounded-full border-2 transition-all duration-500 ${
										isActive
											? "bg-gold-400 border-gold-400 scale-125 shadow-[0_0_15px_rgba(250,227,51,0.6)]"
											: isDone
												? "bg-gold-500/80 border-gold-500/80"
												: "bg-[#050201] border-white/20"
									}`}
								/>
								<span
									className={`absolute top-6 w-24 left-1/2 -translate-x-1/2 text-center text-xs font-medium tracking-wide transition-colors duration-300 leading-tight ${
										isActive
											? "text-gold-100"
											: isDone
												? "text-gray-400"
												: "text-gray-600"
									}`}
								>
									{s.label}
								</span>
							</div>
						);
					})}
				</div>
			</div>
		);
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050201] text-white">
			{/* Background Ambient */}
			<div className="absolute inset-0 overflow-hidden pointer-events-none">
				<div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-coffee-900/20 rounded-full blur-[120px]" />
				<div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-gold-900/10 rounded-full blur-[120px]" />
			</div>

			<div className="relative w-full max-w-4xl h-[85vh] mx-auto glass-tepora rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-modal-enter border border-white/5">
				{/* Header */}
				<div className="relative z-20 bg-black/20 backdrop-blur-sm border-b border-white/5">
					<div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-gold-500/20 to-transparent opacity-50" />
					<div className="pt-8 pb-2 text-center relative">
						<h1 className="text-3xl font-display font-bold text-transparent bg-clip-text bg-gradient-to-r from-gold-100 via-white to-gold-100 tracking-wider drop-shadow-sm">
							{stepTitles[state.step]}
						</h1>
						{onSkip && (
							<button
								type="button"
								onClick={onSkip}
								className="absolute top-1/2 -translate-y-1/2 right-8 text-sm text-gray-500 hover:text-white transition-colors border border-white/10 hover:border-white/30 rounded-full px-4 py-1.5 backdrop-blur-md bg-black/20"
							>
								{t("setup.skip_setup", "Skip Setup")}
							</button>
						)}
					</div>
					{renderProgressDots()}
				</div>

				{/* Body */}
				<div className="flex-1 relative overflow-hidden">
					{/* Content Container */}
					<div className="absolute inset-0 overflow-y-auto custom-scrollbar p-8 md:p-12">
						<div className="max-w-3xl mx-auto h-full flex flex-col animate-slide-up">
							{renderStep()}
						</div>
					</div>
				</div>

				{pendingConsent ? (
					<div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
						<div className="w-full max-w-lg mx-6 glass-tepora rounded-2xl border border-white/10 shadow-xl p-6">
							<h2 className="text-2xl font-display font-semibold mb-3 text-gold-200">
								{t("setup.download_warning_title", "Confirm Model Download")}
							</h2>
							<p className="text-sm text-white/70 mb-4">
								{t(
									"setup.download_warning_desc",
									"Some models are not in the allowlist. Please review the warnings and confirm to proceed.",
								)}
							</p>
							<div className="space-y-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
								{pendingConsent.warnings.map((warning) => (
									<div
										key={`${warning.repo_id}:${warning.filename}`}
										className="rounded-lg bg-white/5 border border-white/10 p-3"
									>
										<div className="text-sm font-semibold text-white mb-1">
											{warning.repo_id} / {warning.filename}
										</div>
										<ul className="text-xs text-white/70 space-y-1">
											{warning.warnings.map((msg, idx) => (
												<li key={`${warning.repo_id}:${idx}`}>- {msg}</li>
											))}
										</ul>
									</div>
								))}
							</div>
							<div className="mt-5 flex gap-3 justify-end">
								<button
									type="button"
									className="px-4 py-2 rounded-full border border-white/20 text-white/80 hover:text-white hover:border-white/40 transition"
									onClick={() => setPendingConsent(null)}
								>
									{t("setup.download_warning_cancel", "Cancel")}
								</button>
								<button
									type="button"
									className="px-4 py-2 rounded-full bg-gold-400 text-black font-semibold hover:bg-gold-300 transition"
									onClick={async () => {
										if (!pendingConsent) return;
										const { targetModels } = pendingConsent;
										setPendingConsent(null);
										try {
											await runSetup(targetModels, true);
										} catch (err) {
											dispatch({
												type: "INSTALL_FAILURE",
												payload:
													err instanceof Error ? err.message : "Start failed",
											});
										}
									}}
								>
									{t("setup.download_warning_confirm", "Proceed")}
								</button>
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
