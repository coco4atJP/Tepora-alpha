import type React from "react";
import { useTranslation } from "react-i18next";

export const EmptyState: React.FC = () => {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col items-center justify-center p-4 max-w-4xl mx-auto animate-fade-in w-full">
			{/* Hero Section */}
			<div className="text-center relative group">
				<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[radial-gradient(circle,rgba(245,158,11,0.15)_0%,transparent_60%)] pointer-events-none group-hover:animate-pulse transition-all duration-1000" />
				<h1 className="text-6xl md:text-7xl lg:text-8xl font-[Playfair_Display] font-medium text-transparent bg-clip-text bg-gradient-to-r from-gold-400 via-tea-100 to-gold-300 tracking-widest mb-6 drop-shadow-[0_0_20px_rgba(255,215,0,0.4)] animate-float-gentle">
					TEPORA
				</h1>
				<p className="text-gray-400 text-lg md:text-xl font-light tracking-widest max-w-lg mx-auto leading-relaxed font-sans opacity-80">
					{t("empty.hero.subtitle", "Your intelligent AI companion for code and creativity")}
				</p>
			</div>
		</div>
	);
};
