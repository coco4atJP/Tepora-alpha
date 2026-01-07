import { ChevronRight } from "lucide-react";
import type { LanguageStepProps } from "../types";

const languages = [
	{ code: "en", label: "English", flag: "🇺🇸" },
	{ code: "ja", label: "日本語", flag: "🇯🇵" },
	{ code: "zh", label: "中文", flag: "🇨🇳" },
	{ code: "es", label: "Español", flag: "🇪🇸" },
] as const;

export default function LanguageStep({ onSelectLanguage }: LanguageStepProps) {
	return (
		<div className="grid grid-cols-2 gap-4">
			{languages.map((lang) => (
				<button
					key={lang.code}
					type="button"
					onClick={() => onSelectLanguage(lang.code)}
					className="group relative p-6 glass-button hover:bg-white/10 text-left transition-all duration-300"
				>
					<div className="text-3xl mb-2">{lang.flag}</div>
					<div className="text-lg font-medium text-gray-200 group-hover:text-white">
						{lang.label}
					</div>
					<div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
						<ChevronRight className="w-5 h-5 text-gold-400" />
					</div>
				</button>
			))}
		</div>
	);
}
