import { Check, PlayCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CompleteStepProps } from "../types";

export default function CompleteStep({ onFinish }: CompleteStepProps) {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col items-center justify-center py-8 text-center space-y-6">
			<div className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center ring-1 ring-green-500/50">
				<Check className="w-10 h-10 text-green-400" />
			</div>
			<div>
				<h2 className="text-2xl font-bold text-white mb-2">{t("setup.all_set", "All Set!")}</h2>
				<p className="text-gray-400">
					{t("setup.ready_desc", "Tepora is ready to be your AI companion.")}
				</p>
			</div>
			<button
				type="button"
				onClick={onFinish}
				className="px-8 py-3 bg-gradient-to-r from-gold-500 to-gold-400 hover:from-gold-400 hover:to-gold-300 text-black font-semibold rounded-lg shadow-lg shadow-gold-900/20 transform transition-all hover:scale-105 active:scale-95 flex items-center gap-2"
			>
				<PlayCircle className="w-5 h-5" />
				{t("setup.launch", "Launch Tepora")}
			</button>
		</div>
	);
}
