// Layout Components
// Sidebar, Section, and other layout-related components for settings pages

import React, { useState, useRef, useEffect } from "react";
import { ChevronRight } from "lucide-react";

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
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const sidebarRef = useRef<HTMLElement>(null);

	const toggleGroup = (group: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(group)) {
				next.delete(group);
			} else {
				next.add(group);
			}
			return next;
		});
	};

	// Group items
	const groupedItems = items.reduce<{ group: string | null; items: NavItem[] }[]>((acc, item) => {
		const groupName = item.group || null;
		const existingGroup = acc.find((g) => g.group === groupName);
		if (existingGroup) {
			existingGroup.items.push(item);
		} else {
			acc.push({ group: groupName, items: [item] });
		}
		return acc;
	}, []);

	// Keyboard Navigation
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!sidebarRef.current) return;

		const focusableElements = Array.from(
			sidebarRef.current.querySelectorAll<HTMLElement>(".focusable-sidebar-item")
		);

		if (focusableElements.length === 0) return;

		const currentIndex = focusableElements.indexOf(document.activeElement as HTMLElement);

		if (e.key === "ArrowDown") {
			e.preventDefault();
			const nextIndex = (currentIndex + 1) % focusableElements.length;
			focusableElements[nextIndex]?.focus();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			const prevIndex = (currentIndex - 1 + focusableElements.length) % focusableElements.length;
			focusableElements[prevIndex]?.focus();
		}
	};

	// Ensure active item's group is not collapsed
	useEffect(() => {
		const activeItemData = items.find((i) => i.id === activeItem);
		if (activeItemData?.group) {
			setCollapsedGroups((prev) => {
				if (prev.has(activeItemData.group!)) { // FIX: Use non-null assertion instead of 'as string'
					const next = new Set(prev);
					next.delete(activeItemData.group!);
					return next;
				}
				return prev;
			});
		}
	}, [activeItem, items]); // FIX: Remove collapsedGroups from dependency array to prevent infinite re-expansion bug


	return (
		<aside
			ref={sidebarRef}
			className="settings-sidebar glass-base border-r border-white/5 flex flex-col"
			onKeyDown={handleKeyDown}
		>
			<div className="settings-sidebar__header text-gradient-gold font-bold tracking-widest flex-none">
				TEPORA
			</div>
			<div className="flex-1 overflow-y-auto min-h-0">
				<nav aria-label="Settings Categories">
					<ul className="settings-sidebar__nav flex flex-col py-2 px-2 gap-1" role="tree">
						{groupedItems.map(({ group, items: groupItems }, groupIndex) => {
							const isCollapsed = group ? collapsedGroups.has(group) : false;
							const isActiveGroup = groupItems.some((i) => i.id === activeItem);

							return (
								<React.Fragment key={group || `ungrouped-${groupIndex}`}>
									{group && (
										<li className="w-full mt-3 mb-1 first:mt-0" role="none">
											<button
												type="button"
												className={`focusable-sidebar-item w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all text-left group/header outline-none focus-visible:ring-2 focus-visible:ring-gold-500/50 ${isActiveGroup ? "bg-gold-500/10 shadow-[inset_0_0_10px_rgba(212,191,128,0.05)] border border-gold-500/20" : "hover:bg-white/5 border border-transparent"}`}
												onClick={() => toggleGroup(group)}
												aria-expanded={!isCollapsed}
											>
												<span className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${isActiveGroup ? "text-gold-400 drop-shadow-[0_0_8px_rgba(212,191,128,0.3)]" : "text-gray-500 group-hover/header:text-gray-300"}`}>
													{group}
												</span>
												<ChevronRight
													size={14}
													className={`transition-transform duration-300 ease-out ${!isCollapsed ? "rotate-90" : ""} ${isActiveGroup ? "text-gold-400" : "text-gray-500 group-hover/header:text-gray-300"}`}
												/>
											</button>
										</li>
									)}
									{(!isCollapsed || !group) && (
										<li role="group" className="w-full relative">
											{group && (
												<div className="absolute left-[18px] top-0 bottom-2 w-px bg-white/5 rounded-full" />
											)}
											<ul className={`flex flex-col w-full gap-0.5 ${group ? "pl-5 mt-1" : ""}`} role="none">
												{groupItems.map((item) => (
													<li key={item.id} className="w-full" role="treeitem" aria-selected={activeItem === item.id}>
														<button
															type="button"
															onClick={() => onSelect(item.id)}
															className={`focusable-sidebar-item settings-sidebar__item group transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-gold-500/50 ${activeItem === item.id ? "settings-sidebar__item--active glass-highlight" : "hover:bg-white/5 hover:translate-x-1"}`}
														>
															<span
																className={`shrink-0 transition-colors duration-300 ${activeItem === item.id ? "text-gold-400" : "text-gray-400 group-hover:text-gray-200"}`}
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
												))}
											</ul>
										</li>
									)}
								</React.Fragment>
							);
						})}
					</ul>
				</nav>
			</div>
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
