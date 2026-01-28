import type React from "react";
import { useTranslation } from "react-i18next";

interface EmbeddingWarningModalProps {
	isOpen: boolean;
	onBack: () => void;
	onProceed: () => void;
}

export const EmbeddingWarningModal: React.FC<EmbeddingWarningModalProps> = ({
	isOpen,
	onBack,
	onProceed,
}) => {
	const { t } = useTranslation();

	if (!isOpen) return null;

	return (
		<div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
			<div className="w-full max-w-lg mx-6 glass-tepora rounded-2xl border border-white/10 shadow-xl p-6">
				<h2 className="text-2xl font-display font-semibold mb-3 text-gold-200">
					{t("setup.embedding_warning_title", "Missing Embedding Model")}
				</h2>
				<p className="text-sm text-white/70 mb-4">
					{t(
						"setup.embedding_warning_desc",
						"Ollama is selected, but no embedding model was found. Some features (RAG, Long-term Memory) require an embedding model.",
					)}
				</p>
				<p className="text-sm text-white/70 mb-6">
					{t(
						"setup.embedding_warning_action",
						"We recommend installing an embedding model, or you can proceed without it.",
					)}
				</p>
				<div className="flex gap-3 justify-end">
					<button
						type="button"
						className="px-4 py-2 rounded-full border border-white/20 text-white/80 hover:text-white hover:border-white/40 transition"
						onClick={onBack}
					>
						{t("common.back", "Back")}
					</button>
					<button
						type="button"
						className="px-4 py-2 rounded-full bg-gold-400 text-black font-semibold hover:bg-gold-300 transition"
						onClick={onProceed}
					>
						{t("setup.embedding_warning_proceed", "Proceed Anyway")}
					</button>
				</div>
			</div>
		</div>
	);
};

interface PendingConsentState {
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
}

interface ConsentWarningModalProps {
	pendingConsent: PendingConsentState | null;
	onCancel: () => void;
	onConfirm: () => void;
}

export const ConsentWarningModal: React.FC<ConsentWarningModalProps> = ({
	pendingConsent,
	onCancel,
	onConfirm,
}) => {
	const { t } = useTranslation();

	if (!pendingConsent) return null;

	return (
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
						onClick={onCancel}
					>
						{t("setup.download_warning_cancel", "Cancel")}
					</button>
					<button
						type="button"
						className="px-4 py-2 rounded-full bg-gold-400 text-black font-semibold hover:bg-gold-300 transition"
						onClick={onConfirm}
					>
						{t("setup.download_warning_confirm", "Proceed")}
					</button>
				</div>
			</div>
		</div>
	);
};
