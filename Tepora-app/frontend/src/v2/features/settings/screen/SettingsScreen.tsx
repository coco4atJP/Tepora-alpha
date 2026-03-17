import { useSettingsScreenModel } from "../model/useSettingsScreenModel";
import { SettingsScreenView } from "../view/SettingsScreenView";

interface SettingsScreenProps {
	isOpen: boolean;
	onClose: () => void;
}

export function SettingsScreen({ isOpen, onClose }: SettingsScreenProps) {
	const model = useSettingsScreenModel({ isOpen, onClose });
	return <SettingsScreenView {...model} />;
}
