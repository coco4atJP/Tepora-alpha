import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Lock, Sparkles, Bot, AlertTriangle } from "lucide-react";
import { useSetupStore } from "../model/setupStore";
import type { InternetPreference, PersonaPreference } from "../model/setupTypes";
import { Button } from "../../../shared/ui/Button";

export default function PreferenceStep() {
	const { t } = useTranslation();
	const store = useSetupStore();
	
	const [localInternet, setLocalInternet] = useState<InternetPreference | null>(store.internetPreference);
	const [localPersona, setLocalPersona] = useState<PersonaPreference | null>(store.personaPreference);

	const handleNext = () => {
		if (localInternet && localPersona) {
			store.setPreference(localInternet, localPersona);
			store.setStep("smart_setup");
		}
	};

	return (
		<div className="flex flex-col animate-fade-in space-y-10">
			
			{/* Axis 1: Internet Connection */}
			<section>
				<h2 className="text-xl font-semibold text-white mb-4">
					{t("setup.preference.internet.title", "Allow Internet Connection?")}
				</h2>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<button
						onClick={() => setLocalInternet("on")}
						className={`relative p-5 rounded-xl border text-left flex flex-col items-start transition-all duration-200
							${localInternet === "on" 
								? "bg-gold-500/10 border-gold-500/50 shadow-[0_0_15px_rgba(251,191,36,0.1)]" 
								: "bg-white/5 border-white/10 hover:bg-white/10"
							}`}
					>
						<Globe className={`w-8 h-8 mb-3 ${localInternet === "on" ? "text-gold-400" : "text-gray-400"}`} />
						<span className={`text-lg font-medium mb-2 ${localInternet === "on" ? "text-gold-100" : "text-gray-200"}`}>
							{t("setup.preference.internet.on.title", "Yes, Online Mode")}
						</span>
						<span className="text-sm text-gray-400">
							{t("setup.preference.internet.on.desc", "Web search and automatic model downloads will be enabled by default.")}
						</span>
					</button>
					
					<button
						onClick={() => setLocalInternet("off")}
						className={`relative p-5 rounded-xl border text-left flex flex-col items-start transition-all duration-200
							${localInternet === "off" 
								? "bg-red-500/10 border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.1)]" 
								: "bg-white/5 border-white/10 hover:bg-white/10"
							}`}
					>
						<Lock className={`w-8 h-8 mb-3 ${localInternet === "off" ? "text-red-400" : "text-gray-400"}`} />
						<span className={`text-lg font-medium mb-2 ${localInternet === "off" ? "text-red-100" : "text-gray-200"}`}>
							{t("setup.preference.internet.off.title", "No, Full Offline")}
						</span>
						<span className="text-sm text-gray-400">
							{t("setup.preference.internet.off.desc", "Maximum privacy. No external connections.")}
						</span>
					</button>
				</div>
				
				{/* Warning for Offline Mode */}
				{localInternet === "off" && (
					<div className="mt-4 p-4 rounded-lg bg-red-950/40 border border-red-900/50 flex gap-3 animate-fade-in">
						<AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
						<div className="text-sm text-red-200/90 leading-relaxed">
							{t("setup.preference.internet.off.warning", 
								"Note: Downloading models will be disabled. You must have an external AI runtime (like Ollama or LM Studio) already installed, or manually provide a local model file."
							)}
						</div>
					</div>
				)}
			</section>

			<hr className="border-white/10" />

			{/* Axis 2: Persona Vibe */}
			<section>
				<h2 className="text-xl font-semibold text-white mb-4">
					{t("setup.preference.persona.title", "Choose AI Persona Style")}
				</h2>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<button
						onClick={() => setLocalPersona("character")}
						className={`relative p-5 rounded-xl border text-left flex flex-col items-start transition-all duration-200
							${localPersona === "character" 
								? "bg-purple-500/10 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.1)]" 
								: "bg-white/5 border-white/10 hover:bg-white/10"
							}`}
					>
						<Sparkles className={`w-8 h-8 mb-3 ${localPersona === "character" ? "text-purple-400" : "text-gray-400"}`} />
						<span className={`text-lg font-medium mb-2 ${localPersona === "character" ? "text-purple-100" : "text-gray-200"}`}>
							{t("setup.preference.persona.character.title", "Character")}
						</span>
						<span className="text-sm text-gray-400">
							{t("setup.preference.persona.character.desc", "A unique, expressive AI partner with personality.")}
						</span>
					</button>
					
					<button
						onClick={() => setLocalPersona("assistant")}
						className={`relative p-5 rounded-xl border text-left flex flex-col items-start transition-all duration-200
							${localPersona === "assistant" 
								? "bg-blue-500/10 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.1)]" 
								: "bg-white/5 border-white/10 hover:bg-white/10"
							}`}
					>
						<Bot className={`w-8 h-8 mb-3 ${localPersona === "assistant" ? "text-blue-400" : "text-gray-400"}`} />
						<span className={`text-lg font-medium mb-2 ${localPersona === "assistant" ? "text-blue-100" : "text-gray-200"}`}>
							{t("setup.preference.persona.assistant.title", "Assistant")}
						</span>
						<span className="text-sm text-gray-400">
							{t("setup.preference.persona.assistant.desc", "Simple, straightforward, and practical AI helper.")}
						</span>
					</button>
				</div>
			</section>

			<div className="flex justify-between items-center pt-4 border-t border-white/5">
				<button 
					onClick={() => store.setStep("language")}
					className="text-gray-400 hover:text-white transition-colors text-sm px-2 py-1"
				>
					{t("common.back", "Back")}
				</button>
				
				<Button
					onClick={handleNext}
					disabled={!localInternet || !localPersona}
					variant="primary"
					className="min-w-[120px]"
				>
					{t("common.next", "Next")}
				</Button>
			</div>
		</div>
	);
}
