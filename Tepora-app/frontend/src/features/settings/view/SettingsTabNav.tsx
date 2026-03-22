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
		<div className="relative z-10 flex-none border-b border-border/30 bg-black/10 px-10 py-8">
			<div className="mx-auto flex w-full max-w-5xl items-baseline gap-10">
				<h2 className="shrink-0 border-r border-white/5 pr-8 font-serif text-4xl italic tracking-tight text-text-main">
					{String(
						t(
						`v2.settings.categories.${activeCategory.id.toLowerCase()}.label`,
						activeCategory.label,
						),
					)}
				</h2>
				<div className="no-scrollbar flex items-center gap-8 overflow-x-auto pb-1">
					{activeCategory.tabs.map((tab: string) => (
						<button
							key={tab}
							onClick={() => onSelectTab(tab)}
							className={`whitespace-nowrap border-b-2 pb-1 text-base transition-all duration-300 ${
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
