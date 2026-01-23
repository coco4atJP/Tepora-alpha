import { ChevronRight, Globe } from "lucide-react";
import type { LanguageStepProps } from "../types";

const languages = [
	{ code: "en", label: "English", sub: "English", flag: "🇺🇸" },
	{ code: "ja", label: "日本語", sub: "Japanese", flag: "🇯🇵" },
	{ code: "zh", label: "中文", sub: "Chinese", flag: "🇨🇳" },
	{ code: "es", label: "Español", sub: "Spanish", flag: "🇪🇸" },
] as const;

export default function LanguageStep({ onSelectLanguage }: LanguageStepProps) {
	return (
		<div className="flex flex-col items-center justify-center h-full py-4 space-y-8 animate-slide-up">
			<div className="text-center space-y-2">
				<div className="inline-flex items-center justify-center p-3 rounded-full bg-gold-500/10 mb-4 ring-1 ring-gold-500/30">
					<Globe className="w-8 h-8 text-gold-400" />
				</div>
				<h2 className="text-2xl font-medium text-white">Select Language</h2>
				<p className="text-gray-400">
					Choose your preferred language to customize Tepora.
				</p>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl">
				{languages.map((lang) => (
					<button
						key={lang.code}
						type="button"
						onClick={() => onSelectLanguage(lang.code)}
						className="setup-card group relative p-6 flex items-center gap-4 text-left hover:border-gold-400/50"
					>
						<span className="text-4xl filter drop-shadow-lg group-hover:scale-110 transition-transform duration-300">
							{lang.flag}
						</span>
						<div className="flex-1">
							<div className="text-xl font-bold text-gray-100 group-hover:text-gold-100 mb-0.5">
								{lang.label}
							</div>
							<div className="text-xs uppercase tracking-wider text-gray-500 group-hover:text-gold-400/70 font-medium">
								{lang.sub}
							</div>
						</div>
						<div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transform translate-x-[-10px] group-hover:translate-x-0 transition-all duration-300">
							<ChevronRight className="w-5 h-5 text-gold-400" />
						</div>
					</button>
				))}
			</div>
		</div>
	);
}
