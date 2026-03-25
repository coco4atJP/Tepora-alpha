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
	const { pattern, isChecking, defaultModels } = useSetupOrchestrator();
	
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
			<div className="flex flex-col items-center justify-center py-12 animate-fade-in">
				<Loader2 className="w-12 h-12 text-gold-500 animate-spin mb-6" />
				<h2 className="text-xl font-medium text-gold-100">
					{t("setup.smart.checking", "Analyzing optimal configuration...")}
				</h2>
				<p className="text-gray-400 mt-2 text-sm">
					{t("setup.smart.checking_desc", "Checking system capabilities and runtimes.")}
				</p>
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
									w-full flex items-center justify-between p-4 rounded-xl border transition-all duration-200 text-left
									${store.selectedModelKeys[m.id]
										? "bg-white/10 border-gold-500/30 shadow-[0_4px_15px_rgba(0,0,0,0.2)]"
										: "bg-white/5 border-white/5 opacity-60 grayscale"
									}
									${isDownloading ? "cursor-default" : "hover:bg-white/15 cursor-pointer"}
								`}
							>
								<div className="flex flex-col">
									<span className={`font-medium ${store.selectedModelKeys[m.id] ? "text-gold-100" : "text-gray-400"}`}>
										{m.display_name}
									</span>
									<span className="text-xs text-gray-500 mt-0.5">
										{m.role === "embedding" ? t("setup.smart.role.embed", "Search / Memory") : t("setup.smart.role.text", "Text Generation")}
										{" • "}
										{formatBytes(m.file_size)}
									</span>
								</div>
								
								<div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
									store.selectedModelKeys[m.id] 
										? "bg-gold-500 border-gold-500" 
										: "border-gray-600"
								}`}>
									{store.selectedModelKeys[m.id] && <CheckCircle2 className="w-3.5 h-3.5 text-black" />}
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
						<div className="mb-8 p-5 bg-black/40 border border-gold-500/20 rounded-xl">
							<div className="flex justify-between items-center mb-3">
								<span className="text-sm font-medium text-gold-200">
									{progressData.message}
								</span>
								<span className="text-sm font-bold text-gold-400">
									{Math.round(progressData.progress * 100)}%
								</span>
							</div>
							<div className="w-full bg-white/10 h-2 rounded-full overflow-hidden">
								<div 
									className="bg-gradient-to-r from-gold-600 to-gold-400 h-full rounded-full transition-all duration-300 ease-out"
									style={{ width: `${Math.max(0, Math.min(100, progressData.progress * 100))}%` }}
								/>
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
