import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Download, CheckCircle2, AlertTriangle } from "lucide-react";
import { useSetupOrchestrator } from "../model/useSetupOrchestrator";
import { useSetupStore } from "../model/setupStore";
import { useSetupPreflightMutation, useSetupRunMutation, useSetupProgressQuery } from "../model/setupQueries";
import { Button } from "../../../shared/ui/Button";

function formatBytes(bytes: number) {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export default function SmartSetupStep() {
	const { t } = useTranslation();
	const store = useSetupStore();
	const { pattern, isChecking, defaultModels, checkError, runSystemCheck } = useSetupOrchestrator();
	
	const { mutateAsync: runPreflight } = useSetupPreflightMutation();
	const { mutateAsync: runSetup } = useSetupRunMutation();
	
	const [isDownloading, setIsDownloading] = useState(false);
	const [downloadError, setDownloadError] = useState<string | null>(null);

	// Poll progress only when downloading
	const { data: progressData } = useSetupProgressQuery(isDownloading);

	// Navigate to Ready step automatically for immediate patterns
	useEffect(() => {
		if (pattern === "A_READY" || pattern === "E_OFFLINE_READY") {
			const timer = setTimeout(() => {
				store.setStep("ready");
			}, 1500); // Brief delay for UX so they see the ✅
			return () => clearTimeout(timer);
		}
	}, [pattern, store]);

	// Initialize selected models from defaults if downloading is needed
	useEffect(() => {
		if ((pattern === "B_DOWNLOAD_ALL" || pattern === "C_DOWNLOAD_EMBED") && defaultModels) {
			defaultModels.models.forEach((m) => {
				if (m.is_active) {
					// Don't auto-select if already in store (preserves user opt-out)
					if (store.selectedModelKeys[m.id] === undefined) {
						store.toggleModelKey(m.id, true);
					}
				}
			});
		}
	}, [pattern, defaultModels, store]);

	const handleDownloadStart = async () => {
		if (!defaultModels) return;

		setDownloadError(null);
		setIsDownloading(true);

		try {
			// Extract selected models mapping into request format
			const targets = defaultModels.models
				.filter(m => store.selectedModelKeys[m.id])
				.map(m => ({
					repo_id: m.repo_id || "",
					filename: m.filename || "",
					display_name: m.display_name,
					modality: m.role === "embedding" ? "embedding" : "text",
					assignment_key: m.role,
				}))
				.filter(m => m.repo_id && m.filename);

			if (targets.length === 0) {
				store.setStep("ready"); // Skipped all downloads
				return;
			}

			// Preflight
			await runPreflight(targets);
			// Start Job
			await runSetup(targets);
			
			// isDownloading=true triggers polling progress hook
		} catch (err) {
			console.error("Download start failed", err);
			setDownloadError(err instanceof Error ? err.message : "Download failed to start");
			setIsDownloading(false);
		}
	};

	// Check polling progress for completion
	useEffect(() => {
		if (isDownloading && progressData) {
			if (progressData.status === "done") {
				setIsDownloading(false);
				store.setStep("ready");
			} else if (progressData.status === "error") {
				setIsDownloading(false);
				setDownloadError(progressData.message || "Download failed during execution");
			}
		}
	}, [isDownloading, progressData, store]);

	if (isChecking || !pattern) {
		return (
			<div className="flex flex-col items-center justify-center py-16 animate-fade-in">
				{checkError ? (
					<div className="flex flex-col items-center text-center">
						<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/20 mb-6 border border-red-500/30">
							<AlertTriangle className="w-8 h-8 text-red-400" />
						</div>
						<h2 className="text-xl font-semibold text-white mb-3">
							{t("setup.smart.error.title", "Analysis Failed")}
						</h2>
						<p className="text-gray-400 text-sm mb-8 max-w-md">
							{checkError.includes("Analysis timed out") 
								? t("setup.smart.error.timeout", "The system analysis timed out. Your local AI runtime might be unresponsive.")
								: checkError}
						</p>
						<div className="flex gap-4">
							<Button 
								variant="secondary" 
								onClick={() => store.internetPreference && runSystemCheck(store.internetPreference)}
							>
								{t("common.retry", "Retry")}
							</Button>
							<Button 
								variant="primary" 
								onClick={() => store.setStep("ready")}
							>
								{t("setup.smart.error.skip", "Skip Analysis")}
							</Button>
						</div>
					</div>
				) : (
					<>
						<div className="relative mb-8">
							<div className="absolute inset-0 bg-gold-500/20 blur-2xl rounded-full animate-slow-breathe" />
							<Loader2 className="w-12 h-12 text-gold-400 animate-spin relative z-10" />
						</div>
						<h2 className="text-xl font-semibold text-transparent bg-clip-text bg-gradient-to-r from-gold-100 via-tea-100 to-gold-200">
							{t("setup.smart.checking", "Analyzing optimal configuration...")}
						</h2>
						<p className="text-gray-400 mt-3 text-sm tracking-wide">
							{t("setup.smart.checking_desc", "Checking system capabilities and runtimes.")}
						</p>
					</>
				)}
			</div>
		);
	}

	// Pattern Route Renderer
	return (
		<div className="flex flex-col animate-fade-in">
			{/* --- Pattern A & E: Ready immediately --- */}
			{(pattern === "A_READY" || pattern === "E_OFFLINE_READY") && (
				<div className="text-center py-8">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500/20 mb-6 border border-green-500/30">
						<CheckCircle2 className="w-8 h-8 text-green-400" />
					</div>
					<h2 className="text-2xl font-semibold text-white mb-3">
						{t("setup.smart.ready.title", "System Ready")}
					</h2>
					<p className="text-gray-400 text-base">
						{pattern === "E_OFFLINE_READY" 
							? t("setup.smart.ready.offline", "Offline runtime detected. Moving to final step...")
							: t("setup.smart.ready.online", "Optimal configuration detected. Moving to final step...")}
					</p>
					<Loader2 className="w-5 h-5 text-gold-500/50 animate-spin mx-auto mt-8" />
				</div>
			)}
			
			{/* --- Pattern D: Offline No Runtime (Error/Fallback) --- */}
			{pattern === "D_OFFLINE_NO_RUN" && (
				<div className="py-4">
					<div className="flex items-center gap-3 mb-6">
						<AlertTriangle className="w-6 h-6 text-red-400" />
						<h2 className="text-xl font-semibold text-white">
							{t("setup.smart.offline_err.title", "External Runtime Required")}
						</h2>
					</div>
					<div className="p-5 rounded-xl bg-red-950/20 border border-red-900/40 mb-8">
						<p className="text-gray-300 leading-relaxed mb-4">
							{t("setup.smart.offline_err.desc", "Because internet connection is disabled, models cannot be downloaded. You must have an external AI runtime running.")}
						</p>
						<ol className="list-decimal pl-5 text-gray-400 space-y-2 text-sm">
							<li>{t("setup.smart.offline_err.step1", "Install and start Ollama or LM Studio on this machine.")}</li>
							<li>{t("setup.smart.offline_err.step2", "Pull a model using their respective commands.")}</li>
							<li>{t("setup.smart.offline_err.step3", "Click 'Re-check' below to connect.")}</li>
						</ol>
					</div>
					
					<div className="flex justify-between items-center">
						<button onClick={() => store.setStep("ready")} className="text-gray-500 hover:text-white text-sm transition-colors">
							{t("setup.smart.offline_err.skip", "Skip (Use local file later)")}
						</button>
						<Button
							onClick={() => store.setStep("preference")} // Resets and re-checks
							variant="secondary"
						>
							{t("common.recheck", "Re-check")}
						</Button>
					</div>
				</div>
			)}

			{/* --- Pattern B & C: Download Models --- */}
			{(pattern === "B_DOWNLOAD_ALL" || pattern === "C_DOWNLOAD_EMBED") && defaultModels && (
				<div className="flex flex-col">
					<div className="mb-6">
						<h2 className="text-xl font-semibold text-white mb-2">
							{pattern === "C_DOWNLOAD_EMBED" 
								? t("setup.smart.dl.embed_only", "Missing Embedding Model")
								: t("setup.smart.dl.title", "Download Required Models")}
						</h2>
						<p className="text-gray-400 text-sm">
							{pattern === "C_DOWNLOAD_EMBED"
								? t("setup.smart.dl.embed_desc", "Your runtime is connected, but a local embedding model is highly recommended for search and memory features.")
								: t("setup.smart.dl.desc", "We will download the recommended models to run privately on your device.")}
						</p>
					</div>

					{/* Download Queue display */}
					<div className="space-y-3 mb-8">
						{defaultModels.models
							.filter(m => pattern === "C_DOWNLOAD_EMBED" ? m.role === "embedding" : m.is_active)
							.map(m => (
							<button
								key={m.id}
								onClick={() => !isDownloading && store.toggleModelKey(m.id, !store.selectedModelKeys[m.id])}
								disabled={isDownloading}
								className={`
									w-full flex items-center justify-between p-4 rounded-xl border transition-all duration-300 text-left relative overflow-hidden
									${store.selectedModelKeys[m.id]
										? "bg-gold-500/5 border-gold-500/40 shadow-[0_4px_20px_rgba(217,119,6,0.1)] ring-1 ring-gold-500/20"
										: "bg-white/5 border-white/5 opacity-50 grayscale hover:opacity-80 hover:grayscale-0"
									}
									${isDownloading ? "cursor-default" : "hover:bg-white/10 cursor-pointer"}
								`}
							>
								{/* Subtle selection glow */}
								{store.selectedModelKeys[m.id] && (
									<div className="absolute inset-0 bg-gradient-to-r from-gold-500/5 to-transparent pointer-events-none" />
								)}

								<div className="flex flex-col relative z-10">
									<span className={`font-semibold tracking-tight ${store.selectedModelKeys[m.id] ? "text-gold-50" : "text-gray-400"}`}>
										{m.display_name}
									</span>
									<span className={`text-xs mt-1 font-medium ${store.selectedModelKeys[m.id] ? "text-gold-200/60" : "text-gray-500"}`}>
										<span className="uppercase tracking-widest opacity-80">
											{m.role === "embedding" ? t("setup.smart.role.embed", "Search / Memory") : t("setup.smart.role.text", "Text Generation")}
										</span>
										{" • "}
										{formatBytes(m.file_size)}
									</span>
								</div>
								
								<div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all duration-300 relative z-10 ${
									store.selectedModelKeys[m.id] 
										? "bg-gold-500 border-gold-400 shadow-[0_0_10px_rgba(251,191,36,0.4)]" 
										: "border-gray-700 bg-black/20"
								}`}>
									{store.selectedModelKeys[m.id] && <CheckCircle2 className="w-4 h-4 text-black stroke-[3px]" />}
								</div>
							</button>
						))}
					</div>
					
					{/* Error Display */}
					{downloadError && (
						<div className="mb-6 p-4 rounded-lg bg-red-950/30 border border-red-900/50 flex flex-col gap-2">
							<div className="flex items-center gap-2 text-red-400 font-medium text-sm">
								<AlertTriangle className="w-4 h-4" />
								{t("setup.smart.dl.error", "Download failed")}
							</div>
							<p className="text-red-200/80 text-xs ml-6">{downloadError}</p>
						</div>
					)}
					
					{/* Progress Display */}
					{isDownloading && progressData && (
						<div className="mb-10 p-6 bg-black/60 border border-gold-500/20 rounded-2xl shadow-inner relative overflow-hidden group">
							{/* Shimmer background */}
							<div className="absolute inset-0 bg-gradient-to-r from-transparent via-gold-500/5 to-transparent -translate-x-full group-hover:animate-shimmer pointer-events-none" />
							
							<div className="flex justify-between items-end mb-4 relative z-10">
								<div className="flex flex-col">
									<span className="text-xs uppercase tracking-[0.2em] text-gold-500/80 font-bold mb-1">
										{t("setup.smart.dl.status", "Downloading Assets")}
									</span>
									<span className="text-sm font-medium text-gold-100">
										{progressData.message}
									</span>
								</div>
								<span className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-gold-400 to-gold-200 tabular-nums">
									{Math.round(progressData.progress * 100)}%
								</span>
							</div>
							
							<div className="w-full bg-white/5 h-2.5 rounded-full overflow-hidden relative z-10 border border-white/5">
								<div 
									className="bg-gradient-to-r from-gold-600 via-gold-400 to-tea-100 h-full rounded-full transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] relative"
									style={{ width: `${Math.max(2, Math.min(100, progressData.progress * 100))}%` }}
								>
									{/* Progress bar light effect */}
									<div className="absolute top-0 right-0 bottom-0 w-8 bg-white/30 blur-sm" />
								</div>
							</div>
						</div>
					)}

					<div className="flex justify-between items-center mt-auto">
						<button 
							onClick={() => store.setStep("preference")}
							disabled={isDownloading}
							className="text-gray-400 hover:text-white transition-colors text-sm px-2 py-1 disabled:opacity-50"
						>
							{t("common.back", "Back")}
						</button>
						
						{isDownloading ? (
							<div className="flex items-center gap-3 px-6 py-3 bg-white/5 border border-white/10 rounded-lg text-gray-300">
								<Loader2 className="w-4 h-4 animate-spin" />
								<span className="text-sm font-medium">{t("setup.smart.dl.downloading", "Downloading...")}</span>
							</div>
						) : (
							<Button
								onClick={handleDownloadStart}
								variant="primary"
								className="min-w-[160px] flex items-center gap-2"
							>
								<Download className="w-4 h-4" />
								<span>{downloadError ? t("common.retry", "Retry") : t("setup.smart.dl.start", "Start Download")}</span>
							</Button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
