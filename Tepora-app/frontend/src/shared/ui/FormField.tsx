import React from "react";

export interface FormFieldProps {
	label: string;
	description?: string;
	error?: string | null;
	children: React.ReactNode;
}

export const FormField: React.FC<FormFieldProps> = ({
	label,
	description,
	error,
	children,
}) => {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-text-main">{label}</label>
				{description ? (
					<p className="text-xs leading-relaxed text-text-muted">{description}</p>
				) : null}
			</div>
			{children}
			{error ? <p className="text-xs text-red-400">{error}</p> : null}
		</div>
	);
};
