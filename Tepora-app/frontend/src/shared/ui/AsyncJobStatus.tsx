import React from "react";

export interface AsyncJobStatusProps {
	status: string;
	progress: number;
	message: string;
}

export const AsyncJobStatus: React.FC<AsyncJobStatusProps> = ({
	status,
	progress,
	message,
}) => {
	const normalized = Math.max(0, Math.min(1, progress));
	const tone =
		status === "completed"
			? "text-emerald-300"
			: status === "failed"
				? "text-red-300"
				: "text-primary";

	return (
		<div className="rounded-2xl border border-white/10 bg-surface/80 p-4">
			<div className="mb-2 flex items-center justify-between gap-4 text-sm">
				<span className={`font-medium ${tone}`}>{status}</span>
				<span className="text-text-muted">{Math.round(normalized * 100)}%</span>
			</div>
			<div className="h-2 overflow-hidden rounded-full bg-bg">
				<div
					className="h-full rounded-full bg-primary transition-all duration-300"
					style={{ width: `${normalized * 100}%` }}
				/>
			</div>
			<p className="mt-3 text-sm leading-relaxed text-text-muted">{message}</p>
		</div>
	);
};
