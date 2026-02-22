import { useCallback, useEffect, useRef, useState } from "react";

interface DialControlProps {
	value: number;
	min: number;
	max: number;
	step?: number;
	label: string;
	onChange: (value: number) => void;
	size?: number;
	unit?: string;
	className?: string;
}

export const DialControl: React.FC<DialControlProps> = ({
	value,
	min,
	max,
	step = 0.1,
	label,
	onChange,
	size = 120,
	unit = "",
	className = "",
}) => {
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

	// Configuration
	// const startAngle = 135;
	// const endAngle = 405;
	// Directly used in calculations or removed if redundant.
	// Checking file content from Step 158:
	// const percent = Math.min(Math.max((value - min) / (max - min), 0), 1);
	// It calls `valueToAngle`.
	// Let's remove startAngle and endAngle declarations if they are unused.

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
			newValue = Number.parseFloat(newValue.toFixed(2));

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
		parsed = Number.parseFloat(parsed.toFixed(2));
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
	const radius = size / 2 - 10; // padding
	const strokeWidth = 6;
	const circumference = 2 * Math.PI * radius;

	// Range: 270 degrees (0.75 of circle)
	const rangePct = 0.75;
	// const offset = circumference * (1 - rangePct); // Gap size in px

	// Calculations for the dash offset based on value
	const progressOffset = circumference * (1 - rangePct * percent);
	const trackOffset = circumference * (1 - rangePct);

	// CSS rotation to place the gap at the bottom (135 deg)

	return (
		<div className={`flex flex-col items-center select-none ${className}`} style={{ width: size }}>
			<div
				ref={dialRef}
				className="relative cursor-pointer group"
				onMouseDown={handleMouseDown}
				style={{ width: size, height: size }}
				role="slider"
				tabIndex={0}
				aria-valuenow={value}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-label={label}
				onKeyDown={() => {
					/* Add keyboard support if needed */
				}}
			>
				{/* Background Glow */}
				<div className="absolute inset-0 bg-gold-400/5 rounded-full blur-xl group-hover:bg-gold-400/10 transition-all duration-300" />

				<svg
					width={size}
					height={size}
					className="transform rotate-[135deg]"
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
						stroke="rgba(255, 255, 255, 0.1)"
						strokeWidth={strokeWidth}
						strokeDasharray={circumference}
						strokeDashoffset={trackOffset}
						strokeLinecap="round"
					/>
					{/* Progress */}
					<circle
						cx={size / 2}
						cy={size / 2}
						r={radius}
						fill="transparent"
						stroke="var(--s-accent, #d4bf80)"
						strokeWidth={strokeWidth}
						strokeDasharray={circumference}
						strokeDashoffset={progressOffset}
						strokeLinecap="round"
						className={`transition-all duration-75 ${isDragging ? "opacity-100" : "opacity-80"}`}
						style={{ filter: "drop-shadow(0 0 4px rgba(212, 191, 128, 0.5))" }}
					/>
				</svg>

				{/* Center Display */}
				<div
					className={`absolute inset-0 flex flex-col items-center justify-center transform ${isEditing ? 'pointer-events-auto' : 'pointer-events-none'}`}
				>
					{isEditing ? (
						<input
							ref={inputRef}
							type="text"
							inputMode="decimal"
							className="w-20 bg-transparent text-center text-2xl font-light text-white tracking-tighter outline-none focus:ring-1 focus:ring-gold-400/50 rounded selection:bg-gold-500/30 -ml-1"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onBlur={commitEdit}
							onKeyDown={handleKeyDown}
						/>
					) : (
						<span
							className="text-2xl font-light text-white tracking-tighter hover:text-gold-300 transition-colors pointer-events-auto cursor-text -ml-1"
							onClick={handleEditStart}
							title="Click to edit"
						>
							{value}
						</span>
					)}
					{unit && <span className="text-xs text-gray-500 -mt-1 pointer-events-none">{unit}</span>}
				</div>
			</div>
			<div className="mt-2 text-sm font-medium text-gray-400">{label}</div>
		</div>
	);
};
