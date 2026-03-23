import { useTranslation } from "react-i18next";
import {
	SETTINGS_CATEGORIES,
	type NavCategory,
} from "./settingsLayoutConfig";

interface SettingsCategoryNavProps {
	activeCategory: NavCategory;
	onSelectCategory: (category: NavCategory) => void;
}

export function SettingsCategoryNav({
	activeCategory,
	onSelectCategory,
}: SettingsCategoryNavProps) {
	const { t } = useTranslation();

	return (
		<div className="relative z-10 flex-none min-w-0 w-full max-w-full border-b border-border/30 px-4 md:px-10 py-3">
			<div className="scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent flex items-center justify-start md:justify-center gap-4 md:gap-8 overflow-x-auto overflow-y-hidden px-2 pb-2 max-w-full">
				{SETTINGS_CATEGORIES.map((category) => (
					<button
						key={category.id}
						onClick={() => onSelectCategory(category.id)}
						className={`relative shrink-0 whitespace-nowrap px-2 py-1 text-xs uppercase tracking-[0.15em] transition-all duration-300 ${
							activeCategory === category.id
								? "font-medium text-gold"
								: "text-text-muted hover:text-text-main"
						}`}
					>
						{t(`v2.settings.categories.${category.id.toLowerCase()}.label`, category.label)}
						{activeCategory === category.id ? (
							<span className="absolute -bottom-[21px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-gold shadow-[0_0_8px_rgba(170,149,85,0.8)]" />
						) : null}
					</button>
				))}
			</div>
		</div>
	);
}
