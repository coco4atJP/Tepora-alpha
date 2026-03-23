import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface DialControlProps {
	value: number;
	min: number;
	max: number;
	step?: number;
	label: string;
	onChange: (value: number) => void;
	size?: number;
	unit?: string;
	className?: string;
	description?: string;
}

export const DialControl: React.FC<DialControlProps> = ({
	value,
	min,
	max,
	step = 0.1,
	label,
	onChange,
	size = 110,
	unit = "",
	className = "",
	description,
}) => {
	const { t } = useTranslation();
	const [isDragging, setIsDragging] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [inputValue, setInputValue] = useState("");
	const dialRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const valueRef = useRef(value);

	// Update ref when value changes to avoid stale closures in listeners
	useEffect(() => {
		valueRef.current = value;
	}, [value]);

	// Calculate current angle from value
	const percent = Math.min(Math.max((value - min) / (max - min), 0), 1);

	// Update value based on mouse position
	const updateValue = useCallback(
		(clientX: number, clientY: number) => {
			if (!dialRef.current) return;

			const rect = dialRef.current.getBoundingClientRect();
			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;

			const dx = clientX - centerX;
			const dy = clientY - centerY;

			// Calculate angle relative to center, 0 at top.
			let cssAngle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
			if (cssAngle < 0) cssAngle += 360;

			// Map angle to 0..1 based on start/end positions
			// Start: 225 deg (Bottom Left), End: 135 deg (Bottom Right)
			// Gap is at the bottom (135 to 225)

			let val: number;
			if (cssAngle >= 225) {
				val = (cssAngle - 225) / 270;
			} else if (cssAngle <= 135) {
				val = (cssAngle + (360 - 225)) / 270;
			} else {
				// In the gap (135 to 225) -> Snap to closest
				if (cssAngle < 180)
					val = 1; // Closer to end
				else val = 0; // Closer to start
			}

			// Clamp
			val = Math.min(Math.max(val, 0), 1);

			// Calculate new value
			let newValue = min + val * (max - min);

			// Step
			if (step) {
				newValue = Math.round(newValue / step) * step;
			}

			// Precision fix
			const fixedDecimals = step >= 1 ? 0 : step < 0.01 ? 3 : 2;
			newValue = Number.parseFloat(newValue.toFixed(fixedDecimals));

			// Clamp value
			newValue = Math.min(Math.max(newValue, min), max);

			// Compare against current ref value to avoid stale closure issues
			if (newValue !== valueRef.current) {
				onChange(newValue);
			}
		},
		[max, min, onChange, step],
	);

	const handleMouseDown = (e: React.MouseEvent) => {
		if (isEditing) return; // Don't start drag if editing
		setIsDragging(true);
		updateValue(e.clientX, e.clientY);
	};

	const handleEditStart = (e: React.MouseEvent) => {
		e.stopPropagation(); // prevent drag
		setIsEditing(true);
		setInputValue(value.toString());
		// Focus uses setTimeout to ensure input is mounted
		setTimeout(() => inputRef.current?.focus(), 0);
	};

	const commitEdit = () => {
		if (!isEditing) return;
		setIsEditing(false);

		let parsed = Number.parseFloat(inputValue);
		if (Number.isNaN(parsed)) {
			// fallback directly to existing value without onChange
			setInputValue(value.toString());
			return;
		}

		if (step) {
			parsed = Math.round(parsed / step) * step;
		}

		// Precision fix & Clamp
		const fixedDecimals = step >= 1 ? 0 : step < 0.01 ? 3 : 2;
		parsed = Number.parseFloat(parsed.toFixed(fixedDecimals));
		parsed = Math.min(Math.max(parsed, min), max);

		if (parsed !== valueRef.current) {
			onChange(parsed);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			commitEdit();
		} else if (e.key === "Escape") {
			setIsEditing(false);
		}
	};

	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (isDragging) {
				e.preventDefault();
				updateValue(e.clientX, e.clientY);
			}
		};

		const handleMouseUp = () => {
			setIsDragging(false);
		};

		if (isDragging) {
			window.addEventListener("mousemove", handleMouseMove);
			window.addEventListener("mouseup", handleMouseUp);
		}

		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging, updateValue]);

	// Visual calculations
	const radius = size / 2 - 12; // padding
	const strokeWidth = 8;
	const circumference = 2 * Math.PI * radius;

	// Range: 270 degrees (0.75 of circle)
	const rangePct = 0.75;

	// Calculations for the dash offset based on value
	const progressOffset = circumference * (1 - rangePct * percent);
	const trackOffset = circumference * (1 - rangePct);

	// CSS rotation to place the gap at the bottom (135 deg)
	return (
		<div className={`flex items-center gap-6 select-none ${className}`}>
			<div
				ref={dialRef}
				className="relative cursor-grab active:cursor-grabbing group flex-shrink-0 flex items-center justify-center rounded-full transition-transform hover:scale-[1.02]"
				onMouseDown={handleMouseDown}
				style={{ width: size, height: size }}
				role="slider"
				tabIndex={0}
				aria-valuenow={value}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-label={label}
				onKeyDown={(e) => {
					// Keyboard support
					if (e.key === "ArrowUp" || e.key === "ArrowRight") {
						e.preventDefault();
						const nextVal = Math.min(value + step, max);
						const fixedDecimals = step >= 1 ? 0 : step < 0.01 ? 3 : 2;
						onChange(Number.parseFloat(nextVal.toFixed(fixedDecimals)));
					} else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
						e.preventDefault();
						const prevVal = Math.max(value - step, min);
						const fixedDecimals = step >= 1 ? 0 : step < 0.01 ? 3 : 2;
						onChange(Number.parseFloat(prevVal.toFixed(fixedDecimals)));
					} else if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						handleEditStart(e as unknown as React.MouseEvent);
					}
				}}
			>
				{/* Background Element - V2 Style */}
				<div className="absolute inset-0 bg-surface-alt/40 border border-border/80 shadow-inner rounded-full group-hover:border-primary/20 group-hover:bg-surface-alt transition-colors duration-300" />
				<div className="absolute inset-2 bg-surface rounded-full shadow-sm border border-border/30" />

				<svg
					width={size}
					height={size}
					className="transform rotate-[135deg] relative z-10"
					aria-label={label}
					role="img"
				>
					<title>{label}</title>
					{/* Track */}
					<circle
						cx={size / 2}
						cy={size / 2}
						r={radius}
						fill="transparent"
						stroke="currentColor"
						strokeWidth={strokeWidth}
						strokeDasharray={circumference}
						strokeDashoffset={trackOffset}
						strokeLinecap="round"
						className="text-border"
					/>
					{/* Progress */}
					<circle
						cx={size / 2}
						cy={size / 2}
						r={radius}
						fill="transparent"
						stroke="currentColor"
						strokeWidth={strokeWidth}
						strokeDasharray={circumference}
						strokeDashoffset={progressOffset}
						strokeLinecap="round"
						className={`text-primary transition-all duration-75 ${isDragging ? "opacity-100 drop-shadow-[0_0_8px_rgba(var(--color-primary),0.6)]" : "opacity-90 drop-shadow-[0_0_2px_rgba(var(--color-primary),0.3)]"}`}
					/>
				</svg>

				{/* Center Display */}
				<div
					className={`absolute inset-0 z-20 flex flex-col items-center justify-center transform ${isEditing ? "pointer-events-auto" : "pointer-events-none"}`}
				>
					{isEditing ? (
						<input
							ref={inputRef}
							type="text"
							inputMode="decimal"
							className="w-16 bg-surface-alt/90 border border-primary/30 text-center text-lg font-medium text-text-main tracking-tight outline-none focus:border-primary rounded-lg shadow-inner z-[30]"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onBlur={commitEdit}
							onKeyDown={handleKeyDown}
							onClick={(e) => e.stopPropagation()}
						/>
					) : (
						<span
							className="text-xl font-bold font-mono tabular-nums text-text-main tracking-tight hover:text-primary transition-colors pointer-events-auto cursor-text text-shadow-sm relative group/edit px-2 py-1"
							onClick={handleEditStart}
							title={t("common.click_to_edit", "Click to edit")}
						>
							{value}
						</span>
					)}
					{unit && <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest mt-0.5 pointer-events-none">{unit}</span>}
				</div>
			</div>
			
			<div className="flex flex-col items-start text-left max-w-[220px]">
				<div className="text-sm font-semibold tracking-widest text-text-main/90 uppercase">
					{label}
				</div>
				{description && (
					<div className="mt-2 text-xs leading-relaxed text-text-muted/70">
						{description}
					</div>
				)}
			</div>
		</div>
	);
};
