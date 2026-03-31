import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, Sparkles, Loader2 } from "lucide-react";
import { useSetupStore } from "../model/setupStore";
import { useSetupFinishMutation } from "../model/setupQueries";
import { Button } from "../../../shared/ui/Button";

interface FirstChatStepProps {
	onComplete: () => void;
}

export default function FirstChatStep({ onComplete }: FirstChatStepProps) {
	const { t } = useTranslation();
	const store = useSetupStore();
	const { mutateAsync: finishSetup } = useSetupFinishMutation();
	
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleFinish = async () => {
		setIsSubmitting(true);
		try {
			// Map preferences to actual backend configurations
			const isOnline = store.internetPreference === "on";
			
			// Decide which persona to map based on pref
			// In standard Tepora, we assume "Tepora" is the default character, 
			// and "Assistant" is a basic model like "AI Assistant".
			// Here we save configurations indicating their choices.
			const activeCharacter = store.personaPreference === "assistant" ? "agent" : "tepora";

			await finishSetup({
				config_overrides: {
					"app.internet_enabled": isOnline,
					"active_character": activeCharacter,
					"privacy.allow_web_search": isOnline,
				}
			});
			
			// Call parent onComplete (refetches requirements and transitions layout)
			onComplete();
		} catch (err) {
			console.error("Failed to finish setup", err);
			// Force completion if backend fails to ensure user isn't stuck
			onComplete();
		} finally {
			setIsSubmitting(false);
		}
	};

	const isCharacter = store.personaPreference === "character";

	return (
		<div className="flex flex-col items-center justify-center py-10 animate-fade-in text-center">
			
			<div className="relative mb-8">
				<div className="absolute inset-0 bg-gold-500/30 blur-3xl opacity-30 animate-slow-breathe rounded-full" />
				{isCharacter ? (
					<div className="relative p-6 rounded-3xl bg-purple-500/10 border border-purple-500/20 shadow-[0_0_40px_rgba(168,85,247,0.1)]">
						<Sparkles className="w-16 h-16 text-purple-300 relative z-10 drop-shadow-[0_0_10px_rgba(168,85,247,0.5)]" />
					</div>
				) : (
					<div className="relative p-6 rounded-3xl bg-blue-500/10 border border-blue-500/20 shadow-[0_0_40px_rgba(59,130,246,0.1)]">
						<MessageSquare className="w-16 h-16 text-blue-300 relative z-10 drop-shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
					</div>
				)}
			</div>

			<h2 className="text-4xl font-bold mb-4 tracking-widest font-[Playfair_Display] text-transparent bg-clip-text bg-gradient-to-r from-gold-400 via-tea-100 to-gold-300 drop-shadow-sm">
				{t("setup.complete.title", "You're All Set")}
			</h2>
			
			<p className="text-tea-100/60 mb-12 max-w-sm leading-relaxed tracking-wide font-medium">
				{isCharacter 
					? t("setup.complete.desc.character", "Your AI partner is ready. Say hello and start your conversation.")
					: t("setup.complete.desc.assistant", "Your practical AI assistant is configured and ready to help.")}
			</p>

			<Button
				onClick={handleFinish}
				disabled={isSubmitting}
				variant="primary"
				className="w-full max-w-xs px-6 py-4 text-base shadow-[0_0_20px_rgba(251,191,36,0.15)] hover:shadow-[0_0_30px_rgba(251,191,36,0.3)] flex items-center justify-center gap-2"
			>
				{isSubmitting && <Loader2 className="w-5 h-5 animate-spin" />}
				<span>
					{isSubmitting 
						? t("setup.complete.btn.starting", "Starting...") 
						: isCharacter
							? t("setup.complete.btn.character", "Start Conversation")
							: t("setup.complete.btn.assistant", "Ask a Question")}
				</span>
			</Button>
		</div>
	);
}
