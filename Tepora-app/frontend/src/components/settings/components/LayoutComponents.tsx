// Layout Components
// Sidebar, Section, and other layout-related components for settings pages

import type React from "react";

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
                        <li key={item.id}>
                            <button
                                type="button"
                                onClick={() => onSelect(item.id)}
                                className={`settings-sidebar__item ${activeItem === item.id ? "settings-sidebar__item--active" : ""}`}
                            >
                                {item.icon}
                                {item.label}
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
            {icon && <span className="settings-section__icon">{icon}</span>}
            <h2 className="settings-section__title">{title}</h2>
        </div>
        {description && (
            <p className="settings-section__description">{description}</p>
        )}
        {children}
    </section>
);
