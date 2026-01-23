// SetupWizard Types

export type SetupStep =
	| "LANGUAGE"
	| "CHECK_REQUIREMENTS"
	| "MODEL_CONFIG"
	| "INSTALLING"
	| "COMPLETE"
	| "ERROR";

export interface SetupState {
	step: SetupStep;
	language: string;
	requirements: RequirementsStatus | null;
	defaults: DefaultModelsResponse | null;
	selectedModels: Set<string>;
	customModels: CustomModelsConfig | null;
	progress: ProgressState;
	error: string | null;
	jobId: string | null;
}

export type SetupAction =
	| { type: "SET_LANGUAGE"; payload: string }
	| { type: "REQ_CHECK_START" }
	| { type: "REQ_CHECK_SUCCESS"; payload: RequirementsStatus }
	| { type: "REQ_CHECK_FAILURE"; payload: string }
	| { type: "GOTO_CONFIG" }
	| { type: "SET_DEFAULTS"; payload: DefaultModelsResponse }
	| { type: "TOGGLE_MODEL"; payload: string }
	| { type: "SET_CUSTOM_MODELS"; payload: CustomModelsConfig }
	| { type: "START_INSTALL"; payload: string }
	| { type: "UPDATE_PROGRESS"; payload: ProgressState }
	| { type: "INSTALL_SUCCESS" }
	| { type: "INSTALL_FAILURE"; payload: string }
	| { type: "FINISH_SETUP" }
	| { type: "RESET_ERROR" };

export interface RequirementsStatus {
	is_ready: boolean;
	has_missing: boolean;
	binary: { status: string; version: string | null };
	models: {
		text: { status: string; name: string | null };
		embedding: { status: string; name: string | null };
	};
}

export interface ModelConfig {
	repo_id: string;
	filename: string;
	display_name: string;
	role?: string;
}

export interface DefaultModelsResponse {
	text_models: ModelConfig[];
	embedding: ModelConfig | null;
}

export interface CustomModelsConfig {
	text?: ModelConfig;
	embedding?: ModelConfig;
}

export interface ProgressState {
	status: string;
	progress: number;
	message: string;
}

// Props interfaces for step components
export interface StepProps {
	state: SetupState;
	dispatch: React.Dispatch<SetupAction>;
}

export interface LanguageStepProps {
	onSelectLanguage: (lang: string) => void;
}

export interface ModelConfigStepProps extends StepProps {
	showAdvanced: boolean;
	setShowAdvanced: (show: boolean) => void;
	onStartSetup: () => void;
}

export interface InstallingStepProps {
	progress: ProgressState;
}

export interface CompleteStepProps {
	onFinish: () => void;
}

export interface ErrorStepProps {
	error: string | null;
	onRetry: () => void;
	onSkip?: () => void;
}
