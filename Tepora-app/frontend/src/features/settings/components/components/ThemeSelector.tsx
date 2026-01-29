import { Coffee, Monitor, Moon, Sun } from "lucide-react";
import type React from "react";
import { useTheme } from "../../../../context/ThemeContext";

export const ThemeSelector: React.FC = () => {
	const { theme, setTheme } = useTheme();

	const options = [
		{ id: "system", label: "System", icon: Monitor },
		{ id: "tepora", label: "Tepora", icon: Coffee },
		{ id: "light", label: "Light", icon: Sun },
		{ id: "dark", label: "Dark", icon: Moon },
	] as const;

	return (
		<div className="flex flex-col space-y-3">
			<span className="text-sm font-medium text-theme-subtext">Appearance</span>
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
                                ${isActive
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
				{theme === "tepora" && "The signature classic Tea Salon experience."}
				{theme === "light" && "A bright, crisp workspace."}
				{theme === "dark" && "A neutral, focused dark environment."}
				{theme === "system" && "Matches your operating system preference."}
			</p>
		</div>
	);
};
