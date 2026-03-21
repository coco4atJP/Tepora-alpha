import { Cpu, Database, HardDrive, MessageSquare } from "lucide-react";
import React, { useMemo } from "react";
import type { SetupModel } from "../../../../shared/contracts";
import { Button } from "../../../../shared/ui";

interface SetupModelCardProps {
	model: SetupModel;
	status?: {
		update_available: boolean;
		reason: string;
	};
	isBusy: boolean;
	isChecking: boolean;
	isDeleting: boolean;
	isUpdating: boolean;
	onCheck: () => void;
	onUpdate: () => void;
	onDelete: () => void;
}

export const SetupModelCard: React.FC<SetupModelCardProps> = ({
	model,
	status,
	isBusy,
	isChecking,
	isDeleting,
	isUpdating,
	onCheck,
	onUpdate,
	onDelete,
}) => {
	const formatSize = (bytes: number) => {
		if (bytes === 0) return "Unknown size";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB", "TB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
	};

	const RoleIcon =
		model.role === "embedding" ? Database : model.role === "text" ? MessageSquare : Cpu;
	const roleLabel =
		model.role === "embedding" ? "Embedding" : model.role === "text" ? "Text Generation" : model.role;

	const tags = useMemo(() => {
		const t: string[] = [];
		if (model.role) t.push(model.role);
		if (model.loader) t.push(model.loader);

		const filenameLower = (model.filename || "").toLowerCase();
		if (filenameLower.includes("gguf")) t.push("gguf");
		if (filenameLower.includes("llama3") || filenameLower.includes("llama-3")) t.push("llama-3");
		if (filenameLower.includes("q4_k_m") || filenameLower.includes("q4")) t.push("q4");
		else if (filenameLower.includes("q8_0") || filenameLower.includes("q8")) t.push("q8");
		else if (filenameLower.includes("fp16")) t.push("fp16");

		return Array.from(new Set(t)).slice(0, 4);
	}, [model]);

	return (
		<div className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-surface p-5 transition-all duration-300 hover:border-primary/30 hover:shadow-lg">
			{/* Ambient Hover Glow */}
			<div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-primary/5 blur-2xl transition-colors duration-500 group-hover:bg-primary/10" />

			<div className="relative z-10 mb-5 flex-1">
				<div className="mb-3 flex items-start justify-between min-h-[3rem]">
					<div className="min-w-0 flex-1 pr-4">
						<h4 className="line-clamp-2 font-serif text-[17px] font-semibold tracking-wide text-text-main">
							{model.display_name}
						</h4>
						<div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-primary/80">
							<RoleIcon size={12} />
							<span>{roleLabel}</span>
						</div>
					</div>
					{/* Status Badges */}
					<div className="flex shrink-0 flex-col items-end gap-1.5">
						{model.is_active ? (
							<span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
								Active
							</span>
						) : null}
						{status?.update_available ? (
							<span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400">
								Update
							</span>
						) : status?.reason === "up_to_date" ? (
							<span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
								Latest
							</span>
						) : null}
					</div>
				</div>

				{/* Tags */}
				<div className="mb-4 flex flex-wrap gap-1.5">
					{tags.map((tag, idx) => (
						<span
							key={idx}
							className="rounded bg-primary/5 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-text-muted border border-border/50 uppercase"
						>
							{tag}
						</span>
					))}
				</div>

				<div className="grid grid-cols-2 gap-3 text-xs text-text-muted">
					<div className="flex min-w-0 items-center gap-2">
						<HardDrive size={14} className="shrink-0 opacity-60" />
						<span className="truncate font-medium tracking-wide">{formatSize(model.file_size)}</span>
					</div>
					<div className="flex min-w-0 items-center gap-2" title={model.filename ?? "Unknown"}>
						<Cpu size={14} className="shrink-0 opacity-60" />
						<span className="truncate font-medium tracking-wide">{model.filename ?? "Unknown"}</span>
					</div>
				</div>
			</div>

			{/* Actions - Slide up on hover */}
			<div className="relative z-10 mt-auto flex items-center gap-2 border-t border-border/60 pt-4 opacity-100 md:opacity-0 transition-opacity duration-200 group-hover:opacity-100 min-h-[52px]">
				<Button
					type="button"
					variant="ghost"
					onClick={onCheck}
					disabled={isBusy || isChecking || !model.repo_id}
					className="flex-1 px-2 py-1.5 text-[11px] h-auto min-h-0 uppercase tracking-widest border border-border/50"
				>
					Check
				</Button>
				<Button
					type="button"
					variant="secondary"
					onClick={onUpdate}
					disabled={isBusy || isUpdating || !model.repo_id || !status?.update_available}
					className="flex-1 px-2 py-1.5 text-[11px] h-auto min-h-0 uppercase tracking-widest"
				>
					Update
				</Button>
				<Button
					type="button"
					variant="ghost"
					onClick={onDelete}
					disabled={isBusy || isDeleting}
					className="border border-red-500/20 text-red-500 dark:text-red-400 hover:bg-red-500/10 shrink-0 px-3 py-1.5 h-auto min-h-0"
				>
					Delete
				</Button>
			</div>
		</div>
	);
};
