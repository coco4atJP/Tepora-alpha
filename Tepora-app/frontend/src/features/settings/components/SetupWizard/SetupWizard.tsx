import { useCallback, useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRequirements } from "../../../../hooks/useServerConfig";
import { ApiError, apiClient } from "../../../../utils/api-client";
import { getKey, initialState, setupReducer } from "./reducer";
import { ConsentWarningModal, EmbeddingWarningModal } from "./SetupWarnings";
import {
	CompleteStep,
	ErrorStep,
	InstallingStep,
	LanguageStep,
	LoaderSelectionStep,
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
	const [showEmbeddingWarning, setShowEmbeddingWarning] = useState(false);
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

			// checkRequirements(); // Moved to next step
		} catch (err) {
			console.error("Language set failed", err);
			// dispatch({ type: "REQ_CHECK_START" }); // Don't error out, just stay
		}
	};

	const runSetup = useCallback(async (
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
				loader: state.loader, // Add loader to request
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
	}, [state.loader, t]);

	const handleStartSetup = useCallback(async () => {
		try {
			// Pre-flight Check
			try {
				const preflightData = await apiClient.post<{
					success: boolean;
					error?: string;
					available_mb?: number;
				}>("api/setup/preflight", {
					required_space_mb: 4096, // Request ~4GB check
				});

				if (!preflightData.success) {
					throw new Error(
						preflightData.error ||
						t("setup.errors.preflight_failed", "System check failed"),
					);
				}
			} catch (err: unknown) {
				// Handle API errors (e.g. 507, 403)
				let msg = t("setup.errors.preflight_failed", "System check failed");
				if (err instanceof ApiError) {
					msg = (err.data as { error?: string })?.error || err.message;
				} else if (err instanceof Error) {
					msg = err.message;
				}
				throw new Error(msg);
			}

			const target_models: Array<{
				repo_id: string;
				filename: string;
				display_name: string;
				role: string;
			}> = [];

			if (showAdvanced && state.customModels) {
				// Include text model only if NOT ollama
				if (state.loader !== "ollama" && state.customModels.text) {
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
				// Include text models only if NOT ollama
				if (state.loader !== "ollama") {
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
				}

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
	}, [runSetup, showAdvanced, state.customModels, state.defaults, state.loader, state.selectedModels, t]);

	// --- Effects ---

	// Check for existing session (Resume Capability)
	useEffect(() => {
		const checkResume = async () => {
			try {
				const data = await apiClient.get<ProgressState>("api/setup/progress");
				// If status is active (not idle, not completed, not failed), resume
				// Note: "failed" might also be resumable in some contexts, but sticking to active for now.
				const activeStatuses = [
					"pending",
					"downloading",
					"extracting",
					"installing",
				];
				if (activeStatuses.includes(data.status)) {
					dispatch({ type: "START_INSTALL", payload: "RESUMED_JOB" });
				}
			} catch {
				// Ignore
			}
		};
		checkResume();
	}, []);

	// Load defaults for config screen
	useEffect(() => {
		if (state.step === "MODEL_CONFIG" && !state.defaults) {
			apiClient
				.get<DefaultModelsResponse>("api/setup/default-models")
				.then((data) => {
					dispatch({ type: "SET_DEFAULTS", payload: data });
				})
				.catch(() => { });
		}
	}, [state.step, state.defaults]);

	// Ollama Flow and Warning
	useEffect(() => {
		if (state.step === "MODEL_CONFIG" && state.loader === "ollama") {
			// Check embedding status
			const embedStatus = state.requirements?.models?.embedding?.status;
			if (embedStatus !== "satisfied") {
				// "satisfied" is the enum value for ready
				setShowEmbeddingWarning(true);
			} else {
				// If satisfied, we can skip model selection and download phase (or just finish)
				// But we still need to trigger "Start Setup" to finalize config
				// If embedding is already there, handleStartSetup will just verify/skip download.
				// We need to ensure handleStartSetup doesn't download text models.
				handleStartSetup();
			}
		}
	}, [
		state.step,
		state.loader,
		state.requirements, // If satisfied, we can skip model selection and download phase (or just finish)
		// But we still need to trigger "Start Setup" to finalize config
		// If embedding is already there, handleStartSetup will just verify/skip download.
		// We need to ensure handleStartSetup doesn't download text models.
		handleStartSetup,
	]);

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

	// --- Render ---

	const stepTitles: Record<SetupStep, string> = {
		LANGUAGE: t("setup.title", "Welcome to Tepora"),
		LOADER_SELECT: t("setup.loader_title", "Select Engine"),
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
			case "LOADER_SELECT":
				return (
					<LoaderSelectionStep
						selectedLoader={state.loader}
						onSelectLoader={(loader) =>
							dispatch({ type: "SET_LOADER", payload: loader })
						}
						onNext={() => checkRequirements()}
						onBack={() =>
							dispatch({ type: "SET_LANGUAGE", payload: state.language })
						}
					/>
				);
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
			{ key: "LOADER_SELECT", label: t("setup.step_engine", "Engine") },
			{ key: "MODEL_CONFIG", label: t("setup.step_model", "Model") },
			{ key: "INSTALLING", label: t("setup.step_install", "Install") },
			{ key: "COMPLETE", label: t("setup.step_done", "Complete") },
		] as const;

		const currentIdx = steps.findIndex((s) => s.key === state.step);

		return (
			<div className="w-full px-12 py-6">
				<div className="relative flex justify-between items-center">
					{/* Line Background */}
					<div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-0.5 bg-white/10" />

					{/* Active Line (Progress) */}
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
									className={`w-4 h-4 rounded-full border-2 transition-all duration-500 ${isActive
											? "bg-gold-400 border-gold-400 scale-125 shadow-[0_0_15px_rgba(250,227,51,0.6)]"
											: isDone
												? "bg-gold-500/80 border-gold-500/80"
												: "bg-[#050201] border-white/20"
										}`}
								/>
								<span
									className={`absolute top-6 w-24 left-1/2 -translate-x-1/2 text-center text-xs font-medium tracking-wide transition-colors duration-300 leading-tight ${isActive
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

				<EmbeddingWarningModal
					isOpen={showEmbeddingWarning}
					onBack={() => setShowEmbeddingWarning(false)}
					onProceed={() => {
						setShowEmbeddingWarning(false);
						handleStartSetup();
					}}
				/>

				<ConsentWarningModal
					pendingConsent={pendingConsent}
					onCancel={() => setPendingConsent(null)}
					onConfirm={async () => {
						if (!pendingConsent) return;
						const { targetModels } = pendingConsent;
						setPendingConsent(null);
						try {
							await runSetup(targetModels, true);
						} catch (err) {
							dispatch({
								type: "INSTALL_FAILURE",
								payload: err instanceof Error ? err.message : "Start failed",
							});
						}
					}}
				/>
			</div>
		</div>
	);
}
