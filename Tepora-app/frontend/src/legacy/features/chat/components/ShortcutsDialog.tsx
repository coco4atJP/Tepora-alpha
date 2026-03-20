import { Command, Keyboard, Search, X, XCircle } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";

interface ShortcutsDialogProps {
	isOpen: boolean;
	onClose: () => void;
}

export const ShortcutsDialog: React.FC<ShortcutsDialogProps> = ({ isOpen, onClose }) => {
	const { t } = useTranslation();

	if (!isOpen) return null;

	const shortcuts = [
		{
			icon: Search,
			keys: ["Ctrl", "K"],
			description: t("shortcuts.newSession", "New Session / Search"),
		},
		{
			icon: XCircle,
			keys: ["Esc"],
			description: t("shortcuts.stopGeneration", "Stop Generation"),
		},
		{
			icon: Command,
			keys: ["?"],
			description: t("shortcuts.showHelp", "Show Shortcuts"),
		},
	];

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
			<div className="relative w-full max-w-md bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
				{/* Header */}
				<div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-white/5">
					<div className="flex items-center gap-2 text-gold-400">
						<Keyboard className="w-5 h-5" />
						<h2 className="text-lg font-medium tracking-wide">
							{t("shortcuts.title", "Keyboard Shortcuts")}
						</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="text-gray-400 hover:text-white transition-colors p-1 rounded-full hover:bg-white/10"
					>
						<X className="w-5 h-5" />
					</button>
				</div>

				{/* Content */}
				<div className="p-6 space-y-4">
					{shortcuts.map((shortcut, index) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: Static list
							key={index}
							className="flex items-center justify-between group"
						>
							<div className="flex items-center gap-3 text-gray-300">
								<div className="p-2 rounded-lg bg-white/5 text-gray-400 group-hover:text-gold-300 transition-colors">
									<shortcut.icon className="w-4 h-4" />
								</div>
								<span className="text-sm">{shortcut.description}</span>
							</div>
							<div className="flex items-center gap-1">
								{shortcut.keys.map((key, keyIndex) => (
									<kbd
										// biome-ignore lint/suspicious/noArrayIndexKey: Static list
										key={keyIndex}
										className="px-2 py-1 min-w-[1.5rem] text-center text-xs font-mono font-bold text-gray-400 bg-white/5 border border-white/10 rounded shadow-sm"
									>
										{key}
									</kbd>
								))}
							</div>
						</div>
					))}
				</div>

				{/* Footer */}
				<div className="px-6 py-4 bg-black/20 text-center">
					<p className="text-xs text-center text-gray-500">
						{t("shortcuts.footer", "Press 'Esc' to close this dialog")}
					</p>
				</div>
			</div>

			{/* Backdrop click handler */}
			<div
				className="absolute inset-0 z-[-1]"
				onClick={onClose}
				onKeyUp={(e) => e.key === "Enter" && onClose()}
				/* tabIndex requires interactivity logic but div backdrop usually just click */
				aria-hidden="true"
			/>
		</div>
	);
};
