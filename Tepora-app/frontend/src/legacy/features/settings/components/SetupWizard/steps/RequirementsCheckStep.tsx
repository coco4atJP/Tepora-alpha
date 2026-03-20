import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function RequirementsCheckStep() {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col items-center justify-center py-12 gap-4">
			<Loader2 className="w-12 h-12 text-gold-400 animate-spin" />
			<p className="text-gray-400">{t("setup.checking_desc")}</p>
		</div>
	);
}
