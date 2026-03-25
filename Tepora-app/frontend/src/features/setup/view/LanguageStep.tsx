import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Globe2 } from "lucide-react";
import { useSetupStore } from "../model/setupStore";
import { useSetupInitMutation } from "../model/setupQueries";
import { Button } from "../../../shared/ui/Button";

const LANGUAGES = [
	{ code: "en", label: "English", localName: "English" },
	{ code: "ja", label: "Japanese", localName: "日本語" },
	{ code: "zh-CN", label: "Simplified Chinese", localName: "简体中文" },
	{ code: "es", label: "Spanish", localName: "Español" },
] as const;

export default function LanguageStep() {
	const { t, i18n } = useTranslation();
	const setLanguage = useSetupStore((state) => state.setLanguage);
	const setStep = useSetupStore((state) => state.setStep);
	const { mutateAsync: initSetup } = useSetupInitMutation();
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Determine currently selected language from i18n
	const selectedLang = LANGUAGES.find((lang) => i18n.language.startsWith(lang.code))?.code || "en";

	const handleSelect = async (code: string) => {
		try {
			await i18n.changeLanguage(code);
		} catch (err) {
			console.error("Failed to change language locally", err);
		}
	};

	const handleNext = async () => {
		setIsSubmitting(true);
		try {
			// Save to backend
			await initSetup({ language: selectedLang });
			// Update store and proceed
			setLanguage(selectedLang);
			setStep("preference");
		} catch (err) {
			console.error("Failed to initialize setup on backend", err);
			// Proceed anyway if backend fails to allow local usage
			setLanguage(selectedLang);
			setStep("preference");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="flex flex-col animate-fade-in">
			<div className="flex items-center gap-3 mb-6">
				<Globe2 className="w-6 h-6 text-gold-400" />
				<h2 className="text-xl font-semibold text-white">
					{t("setup.language.title", "Choose your language")}
				</h2>
			</div>

			<p className="text-gray-400 mb-8 text-sm">
				{t("setup.language.subtitle", "You can always change this later in settings.")}
			</p>

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
				{LANGUAGES.map((lang) => {
					const isSelected = selectedLang === lang.code;
					return (
						<button
							key={lang.code}
							onClick={() => handleSelect(lang.code)}
							className={`
								relative flex flex-col items-start p-4 rounded-xl border transition-all duration-200 text-left
								${
									isSelected
										? "bg-gold-500/10 border-gold-500/50 shadow-[0_0_15px_rgba(251,191,36,0.1)]"
										: "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20"
								}
							`}
						>
							<span className={`text-base font-medium mb-1 ${isSelected ? "text-gold-100" : "text-gray-200"}`}>
								{lang.localName}
							</span>
							<span className={`text-xs ${isSelected ? "text-gold-200/70" : "text-gray-500"}`}>
								{lang.label}
							</span>
							
							{isSelected && (
								<div className="absolute top-4 right-4 text-gold-400">
									<Check className="w-5 h-5" />
								</div>
							)}
						</button>
					);
				})}
			</div>

			<div className="flex justify-end mt-4">
				<Button
					onClick={handleNext}
					disabled={isSubmitting}
					variant="primary"
					className="min-w-[120px]"
				>
					{t("common.next", "Next")}
				</Button>
			</div>
		</div>
	);
}
