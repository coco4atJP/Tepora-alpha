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
			
			<div className="relative mb-6">
				<div className="absolute inset-0 bg-gold-400 blur-2xl opacity-20 animate-pulse rounded-full" />
				{isCharacter ? (
					<Sparkles className="w-16 h-16 text-purple-400 relative z-10" />
				) : (
					<MessageSquare className="w-16 h-16 text-blue-400 relative z-10" />
				)}
			</div>

			<h2 className="text-3xl font-semibold text-white mb-4 tracking-wide font-[Playfair_Display]">
				{t("setup.complete.title", "You're All Set")}
			</h2>
			
			<p className="text-gray-400 mb-12 max-w-sm">
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
