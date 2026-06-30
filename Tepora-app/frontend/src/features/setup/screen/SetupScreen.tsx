import SetupLayout from "../view/SetupLayout";
import LanguageStep from "../view/LanguageStep";
import PreferenceStep from "../view/PreferenceStep";
import SmartSetupStep from "../view/SmartSetupStep";
import FirstChatStep from "../view/FirstChatStep";
import { useSetupStore } from "../model/setupStore";

interface SetupScreenProps {
	onComplete: () => void;
}

export default function SetupScreen({ onComplete }: SetupScreenProps) {
	const step = useSetupStore((state) => state.step);

	return (
		<SetupLayout>
			{step === "language" && <LanguageStep />}
			{step === "preference" && <PreferenceStep />}
			{step === "smart_setup" && <SmartSetupStep />}
			{step === "ready" && <FirstChatStep onComplete={onComplete} />}
		</SetupLayout>
	);
}
