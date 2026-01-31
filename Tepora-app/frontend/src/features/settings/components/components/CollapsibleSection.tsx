import { ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import type React from "react";
import { useState } from "react";

interface CollapsibleSectionProps {
	title: string;
	children: React.ReactNode;
	defaultOpen?: boolean;
	description?: string;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
	title,
	children,
	defaultOpen = false,
	description,
}) => {
	const [isOpen, setIsOpen] = useState(defaultOpen);

	return (
		<div className="border border-white/5 rounded-lg overflow-hidden my-4 bg-white/2">
			<div
				role="button"
				tabIndex={0}
				onClick={() => setIsOpen(!isOpen)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setIsOpen(!isOpen);
					}
				}}
				className="w-full flex items-center justify-between p-3 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
			>
				<div className="flex items-center gap-2 text-sm font-medium text-gray-200">
					{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
					{title}
					{description && (
						<button
							type="button"
							className="group relative"
							onClick={(e) => e.stopPropagation()} // Prevent collapse when clicking tooltip
							onKeyDown={(e) => e.stopPropagation()} // Prevent triggering parent collapse on Enter/Space
						>
							<HelpCircle size={14} className="text-gray-500 hover:text-gray-300" />
							<div className="absolute top-full left-0 mt-2 w-64 p-2 bg-gray-900 border border-white/10 rounded-md shadow-xl text-xs text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
								{description}
							</div>
						</button>
					)}
				</div>
			</div>
			{isOpen && (
				<div className="p-4 border-t border-white/5 animate-in slide-in-from-top-2 duration-200">
					{children}
				</div>
			)}
		</div>
	);
};
