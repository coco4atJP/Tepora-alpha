import { useTranslation } from "react-i18next";
import type { SetupLoader } from "../types";

interface LoaderSelectionStepProps {
	selectedLoader: SetupLoader;
	onSelectLoader: (loader: SetupLoader) => void;
	onNext: () => void;
	onBack: () => void;
}

export function LoaderSelectionStep({
	selectedLoader,
	onSelectLoader,
	onNext,
	onBack,
}: LoaderSelectionStepProps) {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col h-full animate-fade-in">
			<div className="text-center mb-8">
				<h2 className="text-2xl font-display font-semibold mb-2 text-gold-200">
					{t("setup.loader_select_title", "Select LLM Loader")}
				</h2>
				<p className="text-white/60">
					{t("setup.loader_select_desc", "Choose how you want to run the AI models.")}
				</p>
			</div>

			<div className="flex-1 flex flex-col gap-4">
				{/* llama.cpp Option */}
				<button
					type="button"
					onClick={() => onSelectLoader("llama_cpp")}
					className={`relative p-6 rounded-xl border-2 transition-all duration-300 text-left group ${
						selectedLoader === "llama_cpp"
							? "bg-gold-500/10 border-gold-400 shadow-[0_0_20px_rgba(250,227,51,0.1)]"
							: "bg-white/5 border-white/10 hover:border-white/30 hover:bg-white/10"
					}`}
				>
					<div className="flex items-center gap-4">
						<div
							className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
								selectedLoader === "llama_cpp" ? "border-gold-400 bg-gold-400" : "border-white/30"
							}`}
						>
							{selectedLoader === "llama_cpp" && (
								<div className="w-2.5 h-2.5 rounded-full bg-black" />
							)}
						</div>
						<div>
							<h3
								className={`text-lg font-semibold mb-1 transition-colors ${
									selectedLoader === "llama_cpp" ? "text-gold-100" : "text-white"
								}`}
							>
								llama.cpp (Bundled)
							</h3>
							<p className="text-sm text-white/60">
								{t(
									"setup.loader_llama_desc",
									"Recommended. Runs completely offline with included high-performance engine.",
								)}
							</p>
						</div>
					</div>
				</button>

				{/* Ollama Option */}
				<button
					type="button"
					onClick={() => onSelectLoader("ollama")}
					className={`relative p-6 rounded-xl border-2 transition-all duration-300 text-left group ${
						selectedLoader === "ollama"
							? "bg-gold-500/10 border-gold-400 shadow-[0_0_20px_rgba(250,227,51,0.1)]"
							: "bg-white/5 border-white/10 hover:border-white/30 hover:bg-white/10"
					}`}
				>
					<div className="flex items-center gap-4">
						<div
							className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
								selectedLoader === "ollama" ? "border-gold-400 bg-gold-400" : "border-white/30"
							}`}
						>
							{selectedLoader === "ollama" && <div className="w-2.5 h-2.5 rounded-full bg-black" />}
						</div>
						<div>
							<h3
								className={`text-lg font-semibold mb-1 transition-colors ${
									selectedLoader === "ollama" ? "text-gold-100" : "text-white"
								}`}
							>
								Ollama
							</h3>
							<p className="text-sm text-white/60">
								{t(
									"setup.loader_ollama_desc",
									"Connect to an external Ollama instance. Requires Ollama to be installed and running.",
								)}
							</p>
						</div>
					</div>
				</button>
			</div>

			<div className="flex justify-between pt-8 border-t border-white/10 mt-8">
				<button
					type="button"
					onClick={onBack}
					className="px-6 py-2.5 rounded-full border border-white/20 text-white/70 hover:text-white hover:border-white/40 hover:bg-white/5 transition-all duration-300"
				>
					{t("common.back", "Back")}
				</button>
				<button
					type="button"
					onClick={onNext}
					className="px-8 py-2.5 rounded-full bg-gold-400 text-black font-bold tracking-wide hover:bg-gold-300 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(250,227,51,0.4)] transition-all duration-300 transform active:scale-95"
				>
					{t("common.next", "Next")}
				</button>
			</div>
		</div>
	);
}
