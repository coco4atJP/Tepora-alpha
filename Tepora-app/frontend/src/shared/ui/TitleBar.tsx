import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";

export const TitleBar: React.FC = () => {
	const [isMaximized, setIsMaximized] = useState(false);
	const appWindow = getCurrentWindow();

	useEffect(() => {
		const checkMaximized = async () => {
			setIsMaximized(await appWindow.isMaximized());
		};
		// Check on mount
		void checkMaximized();

		// Listen for resize events to update the maximize icon
		let unlisten: (() => void) | undefined;
		appWindow.onResized(() => {
			void checkMaximized();
		}).then((fn) => {
			unlisten = fn;
		}).catch(console.error);

		return () => {
			if (unlisten) unlisten();
		};
	}, [appWindow]);

	const handleMinimize = () => {
		void appWindow.minimize();
	};

	const handleToggleMaximize = async () => {
		if (isMaximized) {
			void appWindow.unmaximize();
		} else {
			void appWindow.maximize();
		}
	};

	const handleClose = () => {
		void appWindow.close();
	};

	return (
		<div
			data-tauri-drag-region
			className="h-8 w-full flex items-center justify-between bg-black/40 backdrop-blur-md select-none sticky top-0 z-[100] border-b border-white/5"
		>
			<div data-tauri-drag-region className="flex items-center pl-4 w-full h-full text-[10px] sm:text-xs font-semibold tracking-[0.2em] font-sans">
				<span className="text-transparent bg-clip-text bg-gradient-to-r from-gold-400 via-tea-100 to-gold-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.3)]">
					TEPORA
				</span>
			</div>
			<div className="flex items-center h-full">
				<button
					type="button"
					onClick={handleMinimize}
					className="h-full w-10 flex items-center justify-center text-text-muted hover:bg-white/10 hover:text-white transition-colors"
					title="Minimize"
				>
					<Minus size={14} />
				</button>
				<button
					type="button"
					onClick={handleToggleMaximize}
					className="h-full w-10 flex items-center justify-center text-text-muted hover:bg-white/10 hover:text-white transition-colors"
					title={isMaximized ? "Restore" : "Maximize"}
				>
					{isMaximized ? <Copy size={12} className="rotate-180" /> : <Square size={13} />}
				</button>
				<button
					type="button"
					onClick={handleClose}
					className="h-full w-10 flex items-center justify-center text-text-muted hover:bg-red-500 hover:text-white transition-colors"
					title="Close"
				>
					<X size={16} />
				</button>
			</div>
		</div>
	);
};
