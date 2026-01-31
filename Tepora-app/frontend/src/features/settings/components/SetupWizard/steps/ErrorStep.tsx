import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ErrorStepProps } from "../types";

export default function ErrorStep({ error, onRetry, onSkip }: ErrorStepProps) {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col items-center justify-center py-8 text-center space-y-6">
			<div className="w-20 h-20 rounded-full bg-red-500/10 flex items-center justify-center ring-1 ring-red-500/50">
				<X className="w-10 h-10 text-red-400" />
			</div>
			<div>
				<h2 className="text-xl font-bold text-white mb-2">{t("setup.failed", "Setup Failed")}</h2>
				<p className="text-red-300 bg-red-900/20 p-3 rounded-lg border border-red-500/20 text-sm max-w-sm mx-auto">
					{error}
				</p>
			</div>
			<div className="flex gap-3">
				<button
					type="button"
					onClick={onRetry}
					className="px-6 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
				>
					{t("common.retry", "Retry")}
				</button>
				{onSkip && (
					<button
						type="button"
						onClick={onSkip}
						className="px-6 py-2 text-gray-500 hover:text-gray-300 transition-colors"
					>
						{t("common.skip", "Skip")}
					</button>
				)}
			</div>
		</div>
	);
}
