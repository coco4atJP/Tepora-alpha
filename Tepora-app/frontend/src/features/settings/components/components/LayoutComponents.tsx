// Layout Components
// Sidebar, Section, and other layout-related components for settings pages

import type React from "react";

import { FitText } from "../../../../components/ui/FitText";

// ============================================================================
// Types
// ============================================================================

export interface NavItem {
	id: string;
	label: string;
	icon: React.ReactNode;
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
	return (
		<aside className="settings-sidebar">
			<div className="settings-sidebar__header">TEPORA</div>
			<nav>
				<ul className="settings-sidebar__nav">
					{items.map((item) => (
						<li key={item.id} className="w-full">
							<button
								type="button"
								onClick={() => onSelect(item.id)}
								className={`settings-sidebar__item ${activeItem === item.id ? "settings-sidebar__item--active" : ""}`}
							>
								<span className="shrink-0">{item.icon}</span>
								<div className="flex-1 min-w-0 h-[24px] flex items-center">
									<FitText maxFontSize={15} minFontSize={10}>
										{item.label}
									</FitText>
								</div>
							</button>
						</li>
					))}
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
	<section className={`settings-section ${className || ""}`} style={style}>
		<div className="settings-section__header">
			{icon && <span className="settings-section__icon shrink-0">{icon}</span>}
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
