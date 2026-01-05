import { Bot, MessageSquare, Search, Settings } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatMode } from "../types";

interface DialControlProps {
	currentMode: ChatMode;
	onModeChange: (mode: ChatMode) => void;
	onSettingsClick: () => void;
}

const DialControl: React.FC<DialControlProps> = ({
	currentMode,
	onModeChange,
	onSettingsClick,
}) => {
	const [rotation, setRotation] = useState(0);
	const [hoveredMode, setHoveredMode] = useState<{
		mode: string;
		x: number;
		y: number;
	} | null>(null);
	const { t } = useTranslation();

	const MODES: {
		mode: ChatMode;
		label: string;
		angle: number;
		icon: React.ElementType;
	}[] = useMemo(
		() => [
			{
				mode: "direct",
				label: t("dial.chat"),
				angle: -90,
				icon: MessageSquare,
			},
			{ mode: "search", label: t("dial.search"), angle: 0, icon: Search },
			{ mode: "agent", label: t("dial.agent"), angle: 90, icon: Bot },
		],
		[t],
	);

	useEffect(() => {
		const targetMode = MODES.find((m) => m.mode === currentMode);
		if (targetMode) {
			setRotation(targetMode.angle);
		}
	}, [currentMode, MODES]);

	const handleModeClick = (mode: ChatMode) => {
		onModeChange(mode);
	};

	const handleMouseEnter = (e: React.MouseEvent, mode: string) => {
		const rect = e.currentTarget.getBoundingClientRect();
		setHoveredMode({
			mode,
			x: rect.left + rect.width / 2,
			y: rect.top - 10, // Position above the icon
		});
	};

	const handleMouseLeave = () => {
		setHoveredMode(null);
	};

	return (
		// Reduced size from w-64 h-64 to w-48 h-48 (approx 25% smaller)
		<div className="relative w-48 h-48 flex items-center justify-center select-none">
			{/* Outer Glow */}
			<div className="absolute inset-0 rounded-full bg-gold-500/5 blur-3xl"></div>

			{/* Outer Ring */}
			<div className="absolute inset-0 rounded-full border-2 border-gold-500/10 bg-coffee-900/60 backdrop-blur-md shadow-[0_0_30px_rgba(0,0,0,0.6)] box-border"></div>

			{/* Decorative ticks ring */}
			<div className="absolute inset-2 rounded-full border border-white/5 border-dashed opacity-30"></div>

			{/* Icons */}
			{MODES.map((m) => {
				const isSelected = currentMode === m.mode;

				// Positioning for 12, 9, 3 o'clock
				// 12 o'clock: top-4 left-1/2
				// 9 o'clock:  top-1/2 left-4
				// 3 o'clock:  top-1/2 right-4
				let positionStyle: React.CSSProperties = {};
				if (m.mode === "search")
					positionStyle = {
						top: "15%",
						left: "50%",
						transform: "translate(-50%, -50%)",
					};
				else if (m.mode === "direct")
					positionStyle = {
						top: "50%",
						left: "15%",
						transform: "translate(-50%, -50%)",
					};
				else if (m.mode === "agent")
					positionStyle = {
						top: "50%",
						right: "15%",
						transform: "translate(50%, -50%)",
					};

				const Icon = m.icon;

				return (
					<div
						key={m.mode}
						onClick={() => handleModeClick(m.mode)}
						onMouseEnter={(e) => handleMouseEnter(e, m.label)}
						onMouseLeave={handleMouseLeave}
						style={positionStyle}
						className={`absolute cursor-pointer transition-all duration-300 z-20 group ${
							isSelected
								? "text-gold-400 scale-110 drop-shadow-[0_0_8px_rgba(255,215,0,0.6)]"
								: "text-coffee-200/50 hover:text-gold-200 hover:scale-110"
						}`}
					>
						<div
							className={`p-2 rounded-full transition-all duration-300 ${isSelected ? "bg-gold-500/10" : "group-hover:bg-white/5"}`}
						>
							<Icon size={24} strokeWidth={2} />
						</div>
					</div>
				);
			})}

			{/* The Dial Knob */}
			<div
				className="w-28 h-28 rounded-full bg-gradient-to-br from-coffee-800 to-black shadow-[inset_0_2px_10px_rgba(255,255,255,0.05),0_10px_30px_rgba(0,0,0,0.8)] flex items-center justify-center relative transition-transform duration-700 cubic-bezier(0.34, 1.56, 0.64, 1) border border-white/10 z-10"
				style={{ transform: `rotate(${rotation}deg)` }}
			>
				{/* Metallic sheen */}
				<div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.08),transparent_60%)]"></div>

				{/* Indicator Line */}
				<div className="absolute top-2 w-1 h-5 bg-gold-500 rounded-full shadow-[0_0_8px_rgba(255,215,0,0.8)]"></div>

				{/* Inner Circle (Settings Button) */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onSettingsClick();
					}}
					onMouseEnter={(e) => handleMouseEnter(e, t("common.settings"))}
					onMouseLeave={handleMouseLeave}
					className="w-14 h-14 rounded-full bg-gradient-to-br from-coffee-700 to-black shadow-[inset_0_1px_4px_rgba(0,0,0,0.5)] flex items-center justify-center hover:scale-105 active:scale-95 transition-all group border border-gold-500/20 backdrop-blur-md relative overflow-hidden z-30"
					aria-label={t("common.settings")}
				>
					<div className="absolute inset-0 bg-gold-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
					<Settings className="w-6 h-6 text-gold-200/60 group-hover:text-gold-100 group-hover:rotate-90 transition-all duration-700" />
				</button>

				{/* Ticks */}
				{[...Array(12)].map((_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: Static decorative elements
					<div
						key={i}
						className={`absolute w-0.5 ${i % 3 === 0 ? "h-1.5 bg-white/20" : "h-1 bg-white/5"}`}
						style={{
							top: "4px",
							left: "50%",
							transformOrigin: "0 52px", // Adjusted for smaller size (28*4 / 2 = 56 - padding) -> approx
							transform: `translateX(-50%) rotate(${i * 30}deg)`,
						}}
					/>
				))}
			</div>

			{/* Tooltip Portal-ish (rendered relative to this container but absolute positioned) */}
			{hoveredMode && (
				<div
					className="fixed pointer-events-none z-50 px-3 py-1.5 bg-gray-900/90 border border-gold-500/30 text-gold-100 text-xs rounded-lg backdrop-blur-sm shadow-xl animate-in fade-in zoom-in-95 duration-200"
					style={{
						left: hoveredMode.x,
						top: hoveredMode.y - 40, // Offset above
						transform: "translateX(-50%)",
					}}
				>
					{hoveredMode.mode}
					<div className="absolute bottom-[-4px] left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-900/90 border-r border-b border-gold-500/30 rotate-45"></div>
				</div>
			)}
		</div>
	);
};

export default DialControl;
