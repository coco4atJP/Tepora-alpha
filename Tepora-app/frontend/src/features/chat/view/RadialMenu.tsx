import React, { useState } from "react";
import { useTranslation } from "react-i18next";

export type ChatModeType = "chat" | "search" | "agent";

export interface RadialMenuProps {
	currentMode: ChatModeType;
	onModeChange: (mode: ChatModeType) => void;
	onOpenSettings?: () => void;
}

const MODE_ITEMS: Array<{
	mode: ChatModeType;
	labelKey: string;
	defaultLabel: string;
	icon: React.ReactNode;
	positionClassName: string;
}> = [
	{
		mode: "chat",
		labelKey: "v2.mode.chat",
		defaultLabel: "Chat",
		positionClassName: "top-2 left-[68px]",
		icon: (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
				<path d="M7 10h10" />
				<path d="M7 14h7" />
				<path d="M4 5h16v11H8l-4 4V5z" />
			</svg>
		),
	},
	{
		mode: "search",
		labelKey: "v2.mode.search",
		defaultLabel: "Search",
		positionClassName: "top-[68px] left-2",
		icon: (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
				<circle cx="11" cy="11" r="7" />
				<path d="m20 20-3.5-3.5" />
			</svg>
		),
	},
	{
		mode: "agent",
		labelKey: "v2.mode.agent",
		defaultLabel: "Agent",
		positionClassName: "top-[68px] right-2",
		icon: (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
				<circle cx="12" cy="5" r="2.5" />
				<circle cx="6" cy="18" r="2.5" />
				<circle cx="18" cy="18" r="2.5" />
				<path d="M12 7.5v4" />
				<path d="M10.5 13.5 7.5 16" />
				<path d="M13.5 13.5 16.5 16" />
			</svg>
		),
	},
];

function currentModeIcon(mode: ChatModeType) {
	return MODE_ITEMS.find((item) => item.mode === mode)?.icon ?? MODE_ITEMS[0]?.icon;
}

export const RadialMenu: React.FC<RadialMenuProps> = ({
	currentMode,
	onModeChange,
	onOpenSettings,
}) => {
	const { t } = useTranslation();
	const [isExpanded, setIsExpanded] = useState(false);

	return (
		<div
			className="relative z-[100] flex h-11 w-11 items-center justify-center"
			onMouseEnter={() => setIsExpanded(true)}
			onMouseLeave={() => setIsExpanded(false)}
		>
			<div
				className={`absolute flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-primary/20 bg-surface/70 text-primary shadow-sm transition-all duration-300 ${
					isExpanded
						? "pointer-events-none scale-75 opacity-0"
						: "scale-100 opacity-100 hover:scale-105 hover:bg-surface/90"
				}`}
			>
				{currentModeIcon(currentMode)}
			</div>

			<div
				className={`absolute left-1/2 top-1/2 flex h-[180px] w-[180px] -ml-[90px] -mt-[90px] items-center justify-center rounded-full border border-[color:var(--glass-border)] bg-[var(--glass-bg)] shadow-[var(--glass-shadow)] backdrop-blur-md transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
					isExpanded
						? "pointer-events-auto rotate-0 scale-100 opacity-100"
						: "pointer-events-none -rotate-45 scale-50 opacity-0"
				}`}
			>
				<button
					type="button"
					onClick={onOpenSettings}
					className="absolute z-10 flex h-11 w-11 items-center justify-center rounded-full border border-primary/15 bg-gradient-to-br from-surface to-bg text-text-muted shadow-sm transition-all duration-200 hover:scale-110 hover:text-gold hover:shadow-[0_0_18px_var(--color-gold-muted)]"
					title={t("v2.settings.open", "Open settings")}
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<circle cx="12" cy="12" r="3" />
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.7 0 1.32.4 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09c-.66 0-1.25.39-1.51 1Z" />
					</svg>
				</button>

				{MODE_ITEMS.map((item) => {
					const active = currentMode === item.mode;
					return (
						<button
							type="button"
							key={item.mode}
							onClick={() => onModeChange(item.mode)}
							className={`group absolute flex h-11 w-11 flex-col items-center justify-center rounded-full transition-all duration-200 ${item.positionClassName} ${
								active
									? "scale-110 bg-gold/12 text-gold shadow-[0_0_18px_var(--color-gold-muted)]"
									: "text-text-muted hover:scale-110 hover:bg-gold/10 hover:text-gold hover:shadow-[0_0_18px_var(--color-gold-muted)]"
							}`}
						>
							{item.icon}
							<span className="absolute -bottom-5 whitespace-nowrap text-[0.65rem] uppercase tracking-widest text-gold opacity-0 transition-all duration-200 group-hover:translate-y-1 group-hover:opacity-100">
								{t(item.labelKey, item.defaultLabel)}
							</span>
						</button>
					);
				})}

				<div className="absolute bottom-2 left-[68px] text-[0.6rem] uppercase tracking-[0.2em] text-text-muted/70">
					{t("v2.settings.label", "Settings")}
				</div>
			</div>
		</div>
	);
};
