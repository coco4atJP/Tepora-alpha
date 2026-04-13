import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSetupStore } from "../model/setupStore";
import { TitleBar } from "../../../shared/ui/TitleBar";

interface SetupLayoutProps {
	children: ReactNode;
}

export default function SetupLayout({ children }: SetupLayoutProps) {
	const { t } = useTranslation();
	const step = useSetupStore((state) => state.step);

	// Define step progress
	const stepIndex = {
		language: 0,
		preference: 1,
		smart_setup: 2,
		ready: 3,
	}[step] ?? 0;

	return (
		<div className="min-h-screen w-full flex flex-col bg-[image:var(--bg-gradient)] relative overflow-hidden font-sans text-text-main selection:bg-gold-500/30">
			<TitleBar />
			<div className="flex-1 w-full flex items-center justify-center relative">
				{/* Background ambient effect */}
				<div className="absolute inset-0 z-0 flex items-center justify-center overflow-hidden">
					<div className="w-[80vw] h-[80vw] md:w-[60vw] md:h-[60vw] bg-[radial-gradient(circle,rgba(219,140,37,0.08)_0%,transparent_60%)] animate-slow-breathe pointer-events-none rounded-full" />
				</div>

				<div className="relative z-10 w-full max-w-2xl px-6 py-12 flex flex-col items-center">
					{/* Logo / Title */}
					<div className="mb-10 text-center select-none">
						<div className="text-transparent bg-clip-text bg-gradient-to-r from-gold-400 via-tea-100 to-gold-300 text-4xl mb-4 font-[Playfair_Display] tracking-widest drop-shadow-[0_0_15px_rgba(255,215,0,0.3)] animate-tea-wave pb-2">
							TEPORA
						</div>
						<div className="text-gold-400/80 text-sm font-medium tracking-[0.2em] uppercase">
							{t("setup.title", "Initial Setup")}
						</div>
					</div>

					{/* Progress Dots */}
					<div className="flex gap-3 mb-12" aria-hidden="true">
						{[0, 1, 2, 3].map((idx) => (
							<div
								key={idx}
								className={`h-1.5 rounded-full transition-all duration-500 ${
									idx === stepIndex
										? "w-8 bg-gold-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]"
										: idx < stepIndex
											? "w-4 bg-gold-400/50"
											: "w-4 bg-white/10"
								}`}
							/>
						))}
					</div>

					{/* Main Content Area */}
					<div className="w-full bg-black/40 backdrop-blur-md border border-white/5 rounded-2xl p-8 shadow-2xl relative overflow-hidden transition-all duration-500 ease-out">
						{/* Inner subtle glow */}
						<div className="absolute top-0 left-1/4 w-1/2 h-px bg-gradient-to-r from-transparent via-gold-500/50 to-transparent" />
						
						{children}
					</div>
				</div>
			</div>
		</div>
	);
}
