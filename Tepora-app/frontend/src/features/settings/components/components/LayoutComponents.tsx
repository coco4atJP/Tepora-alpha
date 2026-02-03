// Layout Components
// Sidebar, Section, and other layout-related components for settings pages

import React from "react";

import { FitText } from "../../../../components/ui/FitText";

// ============================================================================
// Types
// ============================================================================

export interface NavItem {
	id: string;
	label: string;
	icon: React.ReactNode;
	group?: string;
}

// ============================================================================
// SettingsSidebar
// ============================================================================

export interface SettingsSidebarProps {
	items: NavItem[];
	activeItem: string;
	onSelect: (id: string) => void;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
	items,
	activeItem,
	onSelect,
}) => {
	// Helper to track rendered groups to avoid duplicate headers
	const renderedGroups = new Set<string>();

	return (
		<aside className="settings-sidebar glass-base border-r border-white/5">
			<div className="settings-sidebar__header text-gradient-gold font-bold tracking-widest">
				TEPORA
			</div>
			<nav>
				<ul className="settings-sidebar__nav">
					{items.map((item) => {
						const showGroupHeader = item.group && !renderedGroups.has(item.group);
						if (item.group) renderedGroups.add(item.group);

						return (
							<React.Fragment key={item.id}>
								{showGroupHeader && (
									<li className="px-4 py-2 mt-4 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
										{item.group}
									</li>
								)}
								<li className="w-full">
									<button
										type="button"
										onClick={() => onSelect(item.id)}
										className={`settings-sidebar__item group transition-all duration-200 ${activeItem === item.id ? "settings-sidebar__item--active glass-highlight border-l-2 border-l-gold-400" : "hover:bg-white/5 hover:translate-x-1"}`}
									>
										<span
											className={`shrink-0 transition-colors ${activeItem === item.id ? "text-gold-400" : "group-hover:text-gray-300"}`}
										>
											{item.icon}
										</span>
										<div className="flex-1 min-w-0 h-[24px] flex items-center">
											<FitText maxFontSize={15} minFontSize={10}>
												{item.label}
											</FitText>
										</div>
									</button>
								</li>
							</React.Fragment>
						);
					})}
				</ul>
			</nav>
		</aside>
	);
};

// ============================================================================
// SettingsSection
// ============================================================================

export interface SettingsSectionProps {
	title: string;
	icon?: React.ReactNode;
	children: React.ReactNode;
	description?: string;
	className?: string;
	style?: React.CSSProperties;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
	title,
	icon,
	children,
	description,
	className,
	style,
}) => (
	<section className={`settings-section glass-panel p-6 mb-6 ${className || ""}`} style={style}>
		<div className="settings-section__header border-b border-white/5 pb-4 mb-4">
			{icon && <span className="settings-section__icon shrink-0 text-gold-400">{icon}</span>}
			<div className="flex-1 min-w-0 h-[28px] flex items-center">
				<FitText
					className="settings-section__title"
					maxFontSize={18} // 1.125rem
					minFontSize={12}
				>
					{title}
				</FitText>
			</div>
		</div>
		{description && <p className="settings-section__description">{description}</p>}
		{children}
	</section>
);
