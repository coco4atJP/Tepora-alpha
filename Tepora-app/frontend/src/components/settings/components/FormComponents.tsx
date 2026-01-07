// Form Components
// Base form UI components for settings pages

import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";

// ============================================================================
// FormGroup
// ============================================================================

export interface FormGroupProps {
	label: string;
	description?: string;
	children: React.ReactNode;
	error?: string;
}

export const FormGroup: React.FC<FormGroupProps> = ({
	label,
	description,
	children,
	error,
}) => (
	<div className="settings-form-group">
		<div className="settings-form-group__header">
			<label className="settings-form-group__label">{label}</label>
			{description && (
				<p className="settings-form-group__description">{description}</p>
			)}
		</div>
		<div className="settings-form-group__content">{children}</div>
		{error && <p className="settings-form-group__error">{error}</p>}
	</div>
);

// ============================================================================
// FormInput
// ============================================================================

export interface FormInputProps {
	value: string | number;
	onChange: (value: string | number) => void;
	type?: "text" | "number" | "password";
	placeholder?: string;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	className?: string;
}

export const FormInput: React.FC<FormInputProps> = ({
	value,
	onChange,
	type = "text",
	placeholder,
	min,
	max,
	step,
	disabled = false,
	className,
}) => (
	<input
		type={type}
		value={value}
		onChange={(e) =>
			onChange(
				type === "number" ? parseFloat(e.target.value) || 0 : e.target.value,
			)
		}
		placeholder={placeholder}
		min={min}
		max={max}
		step={step}
		disabled={disabled}
		className={`settings-input ${className || ""}`}
	/>
);

// ============================================================================
// FormSwitch
// ============================================================================

export interface FormSwitchProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
}

export const FormSwitch: React.FC<FormSwitchProps> = ({
	checked,
	onChange,
	disabled = false,
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		onClick={() => !disabled && onChange(!checked)}
		disabled={disabled}
		className={`settings-switch ${checked ? "settings-switch--active" : ""} ${disabled ? "settings-switch--disabled" : ""}`}
	>
		<span className="settings-switch__thumb" />
	</button>
);

// ============================================================================
// FormSelect
// ============================================================================

export interface FormSelectProps {
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
	disabled?: boolean;
}

export const FormSelect: React.FC<FormSelectProps> = ({
	value,
	onChange,
	options,
	disabled = false,
}) => (
	<div className="settings-select-wrapper">
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			disabled={disabled}
			className="settings-select"
		>
			{options.map((opt) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
		<ChevronDown className="settings-select__icon" size={16} />
	</div>
);

// ============================================================================
// FormList
// ============================================================================

export interface FormListProps {
	items: string[];
	onChange: (items: string[]) => void;
	placeholder?: string;
}

export const FormList: React.FC<FormListProps> = ({
	items,
	onChange,
	placeholder = "Add item...",
}) => {
	const [newItem, setNewItem] = useState("");

	const handleAdd = () => {
		if (newItem.trim()) {
			onChange([...items, newItem.trim()]);
			setNewItem("");
		}
	};

	const handleRemove = (index: number) => {
		onChange(items.filter((_, i) => i !== index));
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleAdd();
		}
	};

	return (
		<div className="settings-list">
			<div className="settings-list__items">
				{items.map((item, index) => (
					<div key={`${item}-${index}`} className="settings-list__item">
						<code className="settings-list__item-text">{item}</code>
						<button
							type="button"
							onClick={() => handleRemove(index)}
							className="settings-list__item-remove"
							aria-label="Remove item"
						>
							<Trash2 size={14} />
						</button>
					</div>
				))}
			</div>
			<div className="settings-list__add">
				<input
					type="text"
					value={newItem}
					onChange={(e) => setNewItem(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					className="settings-input settings-list__add-input"
				/>
				<button
					type="button"
					onClick={handleAdd}
					className="settings-list__add-button"
					aria-label="Add item"
				>
					<Plus size={16} />
				</button>
			</div>
		</div>
	);
};
