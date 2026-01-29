import { ChevronDown, ChevronRight, Sparkles, Terminal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { InstallingStepProps } from "../types";

export default function InstallingStep({ progress }: InstallingStepProps) {
	const { t } = useTranslation();
	const [showLogs, setShowLogs] = useState(false);

	const getStatusText = () => {
		switch (progress.status) {
			case "extracting":
				return t("setup.extracting", "Extracting components...");
			case "downloading":
				return t("setup.downloading", "Downloading AI models...");
			default:
				return t("setup.installing", "Setting up your environment...");
		}
	};

	return (
		<div className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto space-y-12 animate-slide-up">
			{/* Main Progress Display */}
			<div className="w-full space-y-6 text-center">
				<div className="relative inline-flex items-center justify-center">
					<div className="w-24 h-24 rounded-full border-4 border-white/5 flex items-center justify-center relative">
						<svg
							className="absolute inset-0 w-full h-full -rotate-90"
							viewBox="0 0 100 100"
							role="img"
							aria-label="Progress"
						>
							<title>Progress</title>
							<circle
								cx="50"
								cy="50"
								r="46"
								fill="none"
								stroke="currentColor"
								strokeWidth="8"
								className="text-white/5"
							/>
							<circle
								cx="50"
								cy="50"
								r="46"
								fill="none"
								stroke="currentColor"
								strokeWidth="8"
								className="text-gold-400 transition-all duration-300 ease-out"
								strokeDasharray="289.02" // 2 * PI * 46
								strokeDashoffset={289.02 * (1 - progress.progress)}
								strokeLinecap="round"
							/>
						</svg>
						<div className="text-2xl font-bold font-mono text-gold-100">
							{Math.round(progress.progress * 100)}%
						</div>
					</div>
					{/* Glow effect */}
					<div className="absolute inset-0 bg-gold-400/20 blur-xl rounded-full animate-pulse" />
				</div>

				<div className="space-y-2">
					<h3 className="text-2xl font-display font-bold text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400">
						{getStatusText()}
					</h3>
					<p className="text-sm text-gray-500 max-w-md mx-auto">
						{t("setup.installing_desc")}
					</p>
				</div>
			</div>

			{/* Tips / Waiting Content */}
			<div className="w-full bg-white/5 border border-white/10 rounded-xl p-6 flex items-start gap-4 backdrop-blur-sm">
				<Sparkles className="w-6 h-6 text-gold-400 shrink-0 mt-1" />
				<div>
					<h4 className="font-medium text-gold-100 mb-1">
						{t("setup.did_you_know")}
					</h4>
					<p className="text-sm text-gray-400 leading-relaxed">
						{t("setup.offline_privacy_tip")}
					</p>
				</div>
			</div>

			{/* Logs Toggle */}
			<div className="w-full">
				<button
					type="button"
					onClick={() => setShowLogs(!showLogs)}
					className="flex items-center gap-2 text-xs text-gray-500 hover:text-white transition-colors mx-auto mb-2"
				>
					{showLogs ? (
						<ChevronDown className="w-3 h-3" />
					) : (
						<ChevronRight className="w-3 h-3" />
					)}
					{showLogs ? t("setup.hide_logs") : t("setup.show_logs")}
				</button>

				{showLogs && (
					<div className="glass-terminal p-4 h-32 overflow-y-auto w-full animate-scale-in">
						<div className="flex items-center gap-2 text-gray-500 mb-2 border-b border-white/5 pb-1">
							<Terminal className="w-3 h-3" />
							<span>{t("setup.installer_output")}</span>
						</div>
						<div className="font-mono text-gray-400 space-y-1">
							<div className="opacity-50">...</div>
							<div>
								<span className="text-gold-500 mr-2">➜</span>
								{progress.message}
							</div>
							<span className="inline-block w-2 h-4 bg-gold-500/50 animate-pulse align-middle" />
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
