import type React from "react";
import type { ReactNode } from "react";
import "./settings.css";

interface SettingsLayoutProps {
	children: ReactNode;
}

export const SettingsLayout: React.FC<SettingsLayoutProps> = ({ children }) => {
	return (
		<div className="settings-layout">
			{children}
			{/* Ambient Background Elements - z-[-1] to stay behind all content */}
			<div className="pointer-events-none absolute -top-[20%] -right-[10%] w-[800px] h-[800px] bg-gold-400/5 rounded-full blur-3xl z-[-1]" />
			<div className="pointer-events-none absolute -bottom-[20%] -left-[10%] w-[600px] h-[600px] bg-purple-500/5 rounded-full blur-3xl z-[-1]" />
		</div>
	);
};
