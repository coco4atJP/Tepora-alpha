import { Coffee, Monitor, Moon, Sun } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../../../../context/ThemeContext";

export const ThemeSelector: React.FC = () => {
	const { t } = useTranslation();
	const { theme, setTheme } = useTheme();

	const options = [
		{ id: "system", label: t("settings.appearance.themes.system", "System"), icon: Monitor },
		{ id: "tepora", label: t("settings.appearance.themes.tepora", "Tepora"), icon: Coffee },
		{ id: "light", label: t("settings.appearance.themes.light", "Light"), icon: Sun },
		{ id: "dark", label: t("settings.appearance.themes.dark", "Dark"), icon: Moon },
	] as const;

	return (
		<div className="flex flex-col space-y-3">
			<span className="text-sm font-medium text-theme-subtext">
				{t("settings.appearance.title")}
			</span>
			<div className="flex p-1 space-x-1 bg-black/20 rounded-lg border border-theme-border">
				{options.map((option) => {
					const Icon = option.icon;
					const isActive = theme === option.id;

					return (
						<button
							type="button"
							key={option.id}
							onClick={() => setTheme(option.id)}
							className={`
                                flex-1 flex items-center justify-center space-x-2 py-2 px-3 rounded-md text-sm transition-all duration-200
                                ${
																	isActive
																		? "bg-theme-glass-highlight border border-theme-border-highlight text-theme-accent shadow-sm"
																		: "text-theme-subtext hover:text-theme-text hover:bg-white/5"
																}
                            `}
						>
							<Icon size={16} />
							<span className="hidden sm:inline">{option.label}</span>
						</button>
					);
				})}
			</div>
			<p className="text-xs text-theme-subtext opacity-70 px-1">
				{theme === "tepora" && t("settings.appearance.themes.tepora_desc", "The signature classic Tea Salon experience.")}
				{theme === "light" && t("settings.appearance.themes.light_desc", "A bright, crisp workspace.")}
				{theme === "dark" && t("settings.appearance.themes.dark_desc", "A neutral, focused dark environment.")}
				{theme === "system" && t("settings.appearance.themes.system_desc", "Matches your operating system preference.")}
			</p>
		</div>
	);
};
