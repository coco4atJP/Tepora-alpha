import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { InstallingStepProps } from "../types";

export default function InstallingStep({ progress }: InstallingStepProps) {
	const { t } = useTranslation();

	const getStatusText = () => {
		switch (progress.status) {
			case "extracting":
				return t("setup.extracting", "Extracting...");
			case "downloading":
				return t("setup.downloading", "Downloading...");
			default:
				return t("setup.installing", "Installing...");
		}
	};

	return (
		<div className="space-y-6 py-8">
			<div className="flex flex-col items-center gap-4">
				<div className="relative">
					<Loader2 className="w-16 h-16 text-coffee-500 animate-spin" />
					<div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-gold-400">
						{Math.round(progress.progress * 100)}%
					</div>
				</div>
				<h3 className="text-xl font-medium text-white animate-pulse">
					{getStatusText()}
				</h3>
			</div>

			<div className="bg-black/50 rounded-lg p-4 font-mono text-xs text-gray-400 border border-white/5 h-24 overflow-y-auto">
				<span className="text-gold-500">{">"}</span> {progress.message}
				<span className="animate-pulse">_</span>
			</div>

			<div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
				<div
					className="h-full bg-gradient-to-r from-coffee-500 via-gold-500 to-coffee-400 transition-all duration-300"
					style={{ width: `${progress.progress * 100}%` }}
				/>
			</div>
		</div>
	);
}
