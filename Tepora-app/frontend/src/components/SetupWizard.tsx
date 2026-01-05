import {
	Check,
	CheckCircle,
	ChevronRight,
	Cpu,
	Download,
	Globe,
	HardDrive,
	Loader2,
	PlayCircle,
	Settings,
	X,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { getApiBase, getAuthHeaders } from "../utils/api";

// --- Types ---

type SetupStep =
	| "LANGUAGE"
	| "CHECK_REQUIREMENTS"
	| "MODEL_CONFIG"
	| "INSTALLING"
	| "COMPLETE"
	| "ERROR";

interface SetupState {
	step: SetupStep;
	language: string;
	requirements: RequirementsStatus | null;
	customModels: CustomModelsConfig | null;
	progress: ProgressState;
	error: string | null;
	jobId: string | null;
}

type SetupAction =
	| { type: "SET_LANGUAGE"; payload: string }
	| { type: "REQ_CHECK_START" }
	| { type: "REQ_CHECK_SUCCESS"; payload: RequirementsStatus }
	| { type: "REQ_CHECK_FAILURE"; payload: string }
	| { type: "GOTO_CONFIG" }
	| { type: "SET_CUSTOM_MODELS"; payload: CustomModelsConfig }
	| { type: "START_INSTALL"; payload: string } // jobId
	| { type: "UPDATE_PROGRESS"; payload: ProgressState }
	| { type: "INSTALL_SUCCESS" }
	| { type: "INSTALL_FAILURE"; payload: string }
	| { type: "FINISH_SETUP" }
	| { type: "RESET_ERROR" };

interface RequirementsStatus {
	is_ready: boolean;
	has_missing: boolean;
	binary: { status: string; version: string | null };
	models: {
		text: { status: string; name: string | null };
		embedding: { status: string; name: string | null };
	};
}

interface CustomModelsConfig {
	text?: { repo_id: string; filename: string; display_name?: string };
	executor?: { repo_id: string; filename: string; display_name?: string };
	embedding?: { repo_id: string; filename: string; display_name?: string };
}

interface ProgressState {
	status: string;
	progress: number;
	message: string;
}

// --- Reducer ---

const initialState: SetupState = {
	step: "LANGUAGE",
	language: "en",
	requirements: null,
	customModels: null,
	progress: { status: "idle", progress: 0, message: "" },
	error: null,
	jobId: null,
};

function setupReducer(state: SetupState, action: SetupAction): SetupState {
	switch (action.type) {
		case "SET_LANGUAGE":
			return { ...state, language: action.payload };
		case "REQ_CHECK_START":
			return { ...state, step: "CHECK_REQUIREMENTS", error: null };
		case "REQ_CHECK_SUCCESS":
			return {
				...state,
				requirements: action.payload,
				// If ready, jump to complete. If not, go to config.
				step: action.payload.is_ready ? "COMPLETE" : "MODEL_CONFIG",
			};
		case "REQ_CHECK_FAILURE":
			return {
				...state,
				step: "ERROR",
				error: action.payload,
			};
		case "GOTO_CONFIG":
			return { ...state, step: "MODEL_CONFIG" };
		case "SET_CUSTOM_MODELS":
			return { ...state, customModels: action.payload };
		case "START_INSTALL":
			return {
				...state,
				step: "INSTALLING",
				jobId: action.payload,
				error: null,
				progress: { status: "pending", progress: 0, message: "Starting..." },
			};
		case "UPDATE_PROGRESS":
			return { ...state, progress: action.payload };
		case "INSTALL_SUCCESS":
			return { ...state, step: "COMPLETE", jobId: null };
		case "INSTALL_FAILURE":
			return { ...state, step: "ERROR", error: action.payload, jobId: null };
		case "RESET_ERROR":
			return { ...state, step: "CHECK_REQUIREMENTS", error: null }; // Retry check
		default:
			return state;
	}
}

// --- Component ---

interface SetupWizardProps {
	onComplete: () => void;
	onSkip?: () => void;
}

export default function SetupWizard({ onComplete, onSkip }: SetupWizardProps) {
	const { t, i18n } = useTranslation();
	const [state, dispatch] = useReducer(setupReducer, initialState);
	const [showAdvanced, setShowAdvanced] = useState(false);

	// --- Effects & Actions ---

	// 1. Language Selection (Step 1 -> 2)
	const handleSelectLanguage = async (lang: string) => {
		try {
			await i18n.changeLanguage(lang);
			dispatch({ type: "SET_LANGUAGE", payload: lang });

			// Notify backend of language choice (session init)
			await fetch(`${getApiBase()}/api/setup/init`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...getAuthHeaders(),
				},
				body: JSON.stringify({ language: lang }),
			});

			// Proceed to check requirements
			checkRequirements();
		} catch (err) {
			console.error("Language set failed", err);
			// Still proceed locally
			dispatch({ type: "REQ_CHECK_START" });
		}
	};

	// 2. Check Requirements
	const checkRequirements = useCallback(async () => {
		dispatch({ type: "REQ_CHECK_START" });
		try {
			const res = await fetch(`${getApiBase()}/api/setup/requirements`, {
				headers: { ...getAuthHeaders() },
			});
			if (!res.ok) throw new Error("Requirements check failed");
			const data = await res.json();
			dispatch({ type: "REQ_CHECK_SUCCESS", payload: data });
		} catch (err) {
			dispatch({
				type: "REQ_CHECK_FAILURE",
				payload: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}, []);

	// 3. Start Auto Setup
	const handleStartSetup = async () => {
		try {
			const body = state.customModels
				? { custom_models: state.customModels }
				: {};
			const res = await fetch(`${getApiBase()}/api/setup/run`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...getAuthHeaders(),
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) throw new Error("Failed to start setup");
			const data = await res.json();
			if (data.success) {
				dispatch({ type: "START_INSTALL", payload: data.job_id });
			} else {
				throw new Error(data.error || "Setup failed to start");
			}
		} catch (err) {
			dispatch({
				type: "INSTALL_FAILURE",
				payload: err instanceof Error ? err.message : "Start failed",
			});
		}
	};

	// 4. Poll Progress (While Installing)
	useEffect(() => {
		if (state.step !== "INSTALLING") return;

		const interval = setInterval(async () => {
			try {
				const res = await fetch(`${getApiBase()}/api/setup/progress`, {
					headers: { ...getAuthHeaders() },
				});
				if (res.ok) {
					const data = await res.json();
					dispatch({ type: "UPDATE_PROGRESS", payload: data });

					if (data.status === "completed") {
						dispatch({ type: "INSTALL_SUCCESS" });
						clearInterval(interval);
					} else if (data.status === "failed") {
						dispatch({ type: "INSTALL_FAILURE", payload: data.message });
						clearInterval(interval);
					}
				}
			} catch {
				// Ignore polling errors
			}
		}, 800);

		return () => clearInterval(interval);
	}, [state.step]);

	// 5. Finish Setup
	const handleFinish = async () => {
		try {
			const res = await fetch(`${getApiBase()}/api/setup/finish`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...getAuthHeaders(),
				},
				body: JSON.stringify({ launch: true }),
			});
			if (res.ok) {
				onComplete();
			} else {
				throw new Error("Failed to finalize setup");
			}
		} catch (err) {
			// Even if backend fails to save config, we might want to let user in?
			// But better to show error.
			dispatch({
				type: "INSTALL_FAILURE",
				payload: "Failed to save configuration. Please try again.",
			});
		}
	};

	// --- Helpers ---

	// Load Defaults for Config Screen
	useEffect(() => {
		if (state.step === "MODEL_CONFIG" && !state.customModels) {
			fetch(`${getApiBase()}/api/setup/default-models`, {
				headers: { ...getAuthHeaders() },
			})
				.then((r) => r.json())
				.then((data) => {
					// Backend returns { text: {}, executor: {}, embedding: {} }
					// We can use this as initial state for customModels if needed
					// But for now we just let user override it.
					// If we really want to show defaults in inputs, we should set them.
					dispatch({ type: "SET_CUSTOM_MODELS", payload: data });
				})
				.catch(() => {});
		}
	}, [state.step, state.customModels]);

	// --- Render ---

	const stepTitles: Record<SetupStep, string> = {
		LANGUAGE: t("setup.title", "Welcome to Tepora"),
		CHECK_REQUIREMENTS: t("setup.checking", "Checking System..."),
		MODEL_CONFIG: t("setup.model_settings", "Model Configuration"),
		INSTALLING: t("setup.downloading", "Installing Components..."),
		COMPLETE: t("setup.complete", "Setup Complete"),
		ERROR: t("setup.error", "Setup Error"),
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050201] text-white">
			{/* Background Ambient */}
			<div className="absolute inset-0 overflow-hidden pointer-events-none">
				<div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-coffee-900/20 rounded-full blur-[120px]" />
				<div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-gold-900/10 rounded-full blur-[120px]" />
			</div>

			<div className="relative w-full max-w-2xl mx-4 glass-gemini rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-modal-enter">
				{/* Header */}
				<div className="p-8 border-b border-white/5 text-center">
					<h1 className="text-4xl font-display font-bold text-gradient-tea mb-2 tracking-wide">
						{stepTitles[state.step]}
					</h1>
					{/* Progress Indicator Dots */}
					<div className="flex justify-center gap-2 mt-4">
						{(
							["LANGUAGE", "MODEL_CONFIG", "INSTALLING", "COMPLETE"] as const
						).map((s, i) => {
							const currentIdx = [
								"LANGUAGE",
								"MODEL_CONFIG",
								"INSTALLING",
								"COMPLETE",
							].indexOf(state.step);
							// If current step is ERROR or CHECK, treat as previous step or initial
							if (state.step === "CHECK_REQUIREMENTS") return null; // Hide dots during check? Or show generic.

							const isActive = i === currentIdx;
							const isDone = i < currentIdx;

							return (
								<div
									key={s}
									className={`h-1.5 rounded-full transition-all duration-500 ${
										isActive
											? "w-12 bg-gold-400 shadow-[0_0_10px_rgba(250,227,51,0.5)]"
											: isDone
												? "w-4 bg-coffee-500/50"
												: "w-2 bg-white/10"
									}`}
								/>
							);
						})}
					</div>
				</div>

				{/* Body */}
				<div className="p-8 overflow-y-auto flex-1 custom-scrollbar">
					{state.step === "LANGUAGE" && (
						<div className="grid grid-cols-2 gap-4">
							{[
								{ code: "en", label: "English", flag: "🇺🇸" },
								{ code: "ja", label: "日本語", flag: "🇯🇵" },
								{ code: "zh", label: "中文", flag: "🇨🇳" },
								{ code: "es", label: "Español", flag: "🇪🇸" },
							].map((lang) => (
								<button
									key={lang.code}
									onClick={() => handleSelectLanguage(lang.code)}
									className="group relative p-6 glass-button hover:bg-white/10 text-left transition-all duration-300"
								>
									<div className="text-3xl mb-2">{lang.flag}</div>
									<div className="text-lg font-medium text-gray-200 group-hover:text-white">
										{lang.label}
									</div>
									<div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
										<ChevronRight className="w-5 h-5 text-gold-400" />
									</div>
								</button>
							))}
						</div>
					)}

					{state.step === "CHECK_REQUIREMENTS" && (
						<div className="flex flex-col items-center justify-center py-12 gap-4">
							<Loader2 className="w-12 h-12 text-gold-400 animate-spin" />
							<p className="text-gray-400">{t("setup.checking_desc")}</p>
						</div>
					)}

					{state.step === "MODEL_CONFIG" && (
						<div className="space-y-6">
							<div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 flex gap-3">
								<HardDrive className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
								<div className="text-sm text-blue-200">
									<p className="font-medium mb-1">
										{t(
											"setup.storage_required",
											"Approx. 4GB download required",
										)}
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
								<div className="space-y-4">
									<button
										onClick={() => handleStartSetup()}
										className="w-full text-left p-6 bg-gradient-to-br from-coffee-900/40 to-black/60 border border-gold-500/20 hover:border-gold-500/50 rounded-xl group transition-all duration-300 shadow-lg hover:shadow-gold-900/20"
									>
										<div className="flex items-center justify-between mb-2">
											<div className="flex items-center gap-2">
												<CheckCircle className="w-5 h-5 text-green-400" />
												<span className="font-semibold text-lg text-gold-100">
													{t("setup.recommended", "Recommended Settings")}
												</span>
											</div>
											<ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-gold-400" />
										</div>
										<p className="text-sm text-gray-400 pl-7">
											{t(
												"setup.recommended_desc",
												"Install standard Llama 3 models optimized for speed and quality.",
											)}
										</p>
									</button>

									<button
										onClick={() => setShowAdvanced(true)}
										className="w-full text-left p-4 bg-white/5 border border-white/5 hover:border-white/20 rounded-lg group transition-all"
									>
										<div className="flex items-center justify-between mb-2">
											<div className="flex items-center gap-2">
												<Settings className="w-5 h-5 text-gray-400" />
												<span className="font-semibold text-lg text-gray-200">
													{t("setup.custom", "Custom Configuration")}
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
							) : (
								<div className="space-y-6 animate-in slide-in-from-right-4">
									<div className="flex items-center justify-between">
										<h3 className="text-lg font-medium text-white">
											{t("setup.custom_models", "Custom Models")}
										</h3>
										<button
											onClick={() => setShowAdvanced(false)}
											className="text-xs text-gold-400 hover:underline"
										>
											{t("common.back", "Use Recommendations")}
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
														dispatch({
															type: "SET_CUSTOM_MODELS",
															payload: {
																...state.customModels,
																[role]: {
																	...state.customModels?.[role],
																	repo_id: e.target.value,
																},
															},
														})
													}
												/>
												<input
													placeholder="Filename (e.g. model.gguf)"
													className="glass-input text-sm w-full"
													value={state.customModels?.[role]?.filename || ""}
													onChange={(e) =>
														dispatch({
															type: "SET_CUSTOM_MODELS",
															payload: {
																...state.customModels,
																[role]: {
																	...state.customModels?.[role],
																	filename: e.target.value,
																},
															},
														})
													}
												/>
											</div>
										</div>
									))}

									<button
										onClick={handleStartSetup}
										className="w-full py-3 bg-gold-500 hover:bg-gold-400 text-black font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
									>
										<Download className="w-4 h-4" />
										{t("setup.start_install", "Start Installation")}
									</button>
								</div>
							)}
						</div>
					)}

					{state.step === "INSTALLING" && (
						<div className="space-y-6 py-8">
							<div className="flex flex-col items-center gap-4">
								<div className="relative">
									<Loader2 className="w-16 h-16 text-coffee-500 animate-spin" />
									<div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-gold-400">
										{Math.round(state.progress.progress * 100)}%
									</div>
								</div>
								<h3 className="text-xl font-medium text-white animate-pulse">
									{state.progress.status === "extracting"
										? t("setup.extracting", "Extracting...")
										: state.progress.status === "downloading"
											? t("setup.downloading", "Downloading...")
											: t("setup.installing", "Installing...")}
								</h3>
							</div>

							<div className="bg-black/50 rounded-lg p-4 font-mono text-xs text-gray-400 border border-white/5 h-24 overflow-y-auto">
								<span className="text-gold-500">{">"}</span>{" "}
								{state.progress.message}
								<span className="animate-pulse">_</span>
							</div>

							<div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
								<div
									className="h-full bg-gradient-to-r from-coffee-500 via-gold-500 to-coffee-400 transition-all duration-300"
									style={{ width: `${state.progress.progress * 100}%` }}
								/>
							</div>
						</div>
					)}

					{state.step === "COMPLETE" && (
						<div className="flex flex-col items-center justify-center py-8 text-center space-y-6">
							<div className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center ring-1 ring-green-500/50">
								<Check className="w-10 h-10 text-green-400" />
							</div>
							<div>
								<h2 className="text-2xl font-bold text-white mb-2">
									{t("setup.all_set", "All Set!")}
								</h2>
								<p className="text-gray-400">
									{t(
										"setup.ready_desc",
										"Tepora is ready to be your AI companion.",
									)}
								</p>
							</div>
							<button
								onClick={handleFinish}
								className="px-8 py-3 bg-gradient-to-r from-gold-500 to-gold-400 hover:from-gold-400 hover:to-gold-300 text-black font-semibold rounded-lg shadow-lg shadow-gold-900/20 transform transition-all hover:scale-105 active:scale-95 flex items-center gap-2"
							>
								<PlayCircle className="w-5 h-5" />
								{t("setup.launch", "Launch Tepora")}
							</button>
						</div>
					)}

					{state.step === "ERROR" && (
						<div className="flex flex-col items-center justify-center py-8 text-center space-y-6">
							<div className="w-20 h-20 rounded-full bg-red-500/10 flex items-center justify-center ring-1 ring-red-500/50">
								<X className="w-10 h-10 text-red-400" />
							</div>
							<div>
								<h2 className="text-xl font-bold text-white mb-2">
									{t("setup.failed", "Setup Failed")}
								</h2>
								<p className="text-red-300 bg-red-900/20 p-3 rounded-lg border border-red-500/20 text-sm max-w-sm mx-auto">
									{state.error}
								</p>
							</div>
							<div className="flex gap-3">
								<button
									onClick={() => dispatch({ type: "RESET_ERROR" })}
									className="px-6 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
								>
									{t("common.retry", "Retry")}
								</button>
								{onSkip && (
									<button
										onClick={onSkip}
										className="px-6 py-2 text-gray-500 hover:text-gray-300 transition-colors"
									>
										{t("common.skip", "Skip")}
									</button>
								)}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
