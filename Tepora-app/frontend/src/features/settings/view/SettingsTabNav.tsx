import { useTranslation } from "react-i18next";
import type { SettingsCategoryDefinition } from "./settingsLayoutConfig";

interface SettingsTabNavProps {
	activeCategory: SettingsCategoryDefinition;
	activeTab: string;
	onSelectTab: (tab: string) => void;
}

export function SettingsTabNav({
	activeCategory,
	activeTab,
	onSelectTab,
}: SettingsTabNavProps) {
	const { t } = useTranslation();

	return (
		<div className="relative z-10 flex-none min-w-0 w-full max-w-full border-b border-border/30 bg-black/10 px-4 md:px-10 py-8">
			<div className="mx-auto flex w-full max-w-5xl items-baseline flex-wrap md:flex-nowrap gap-4 md:gap-10">
				<h2 className="shrink-0 border-r border-white/5 pr-4 md:pr-8 font-serif text-2xl md:text-4xl italic tracking-tight text-text-main">
					{String(
						t(
						`v2.settings.categories.${activeCategory.id.toLowerCase()}.label`,
						activeCategory.label,
						),
					)}
				</h2>
				<div className="scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent flex min-w-0 w-full md:flex-1 max-w-full items-center gap-4 md:gap-8 overflow-x-auto overflow-y-hidden pb-2">
					{activeCategory.tabs.map((tab: string) => (
						<button
							key={tab}
							onClick={() => onSelectTab(tab)}
							className={`whitespace-nowrap shrink-0 border-b-2 pb-1 text-base transition-all duration-300 ${
								activeTab === tab
									? "border-gold text-text-main"
									: "border-transparent text-text-muted hover:text-text-main"
							}`}
						>
							{t(
								`v2.settings.categories.${activeCategory.id.toLowerCase()}.tabs.${tab
									.toLowerCase()
									.replace(/\s+/g, "_")}`,
								tab,
							)}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
