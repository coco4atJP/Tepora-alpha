import { Search, RefreshCw } from "lucide-react";
import React from "react";
import { Button } from "../../../../shared/ui";

interface ModelManagementControlsProps {
	searchTerm: string;
	onSearchTermChange: (value: string) => void;
	activeRole: "all" | "text" | "embedding";
	onActiveRoleChange: (role: "all" | "text" | "embedding") => void;
	onCheckUpdates: () => void;
	isChecking: boolean;
	remoteModelCount: number;
	isBusy: boolean;
	onRefresh: () => void;
	isRefreshing: boolean;
}

export const ModelManagementControls: React.FC<ModelManagementControlsProps> = ({
	searchTerm,
	onSearchTermChange,
	activeRole,
	onActiveRoleChange,
	onCheckUpdates,
	isChecking,
	remoteModelCount,
	isBusy,
	onRefresh,
	isRefreshing,
}) => {
	return (
		<div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 justify-between bg-surface/30 p-2 rounded-2xl border border-border/40 pb-2">
			<div className="relative w-full sm:max-w-xs xl:max-w-md shrink-0">
				<Search
					className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted opacity-60"
					size={16}
				/>
				<input
					type="text"
					placeholder="Search models..."
					value={searchTerm}
					onChange={(e) => onSearchTermChange(e.target.value)}
					className="block w-full font-sans text-sm text-text-main bg-surface/60 border border-border/50 rounded-xl pl-10 pr-4 py-2.5 transition-colors duration-200 ease-out hover:border-primary/50 focus:bg-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary placeholder:text-text-muted/60"
				/>
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<div className="flex items-center gap-1 p-1 bg-surface/50 border border-border/50 rounded-xl overflow-x-auto no-scrollbar shrink-0">
					{(["all", "text", "embedding"] as const).map((role) => (
						<button
							key={role}
							onClick={() => onActiveRoleChange(role)}
							className={`
								px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all whitespace-nowrap
								${
									activeRole === role
										? "bg-primary/10 text-primary border border-primary/20 shadow-sm"
										: "text-text-muted hover:text-text-main hover:bg-surface/50 border border-transparent"
								}
							`}
						>
							{role === "all" ? "All" : role === "text" ? "Text" : "Embedding"}
						</button>
					))}
				</div>

				<Button
					type="button"
					variant="secondary"
					onClick={onRefresh}
					disabled={isRefreshing || isBusy}
					className="shrink-0 h-[34px] px-3 rounded-xl border border-secondary/30"
					title="Refresh Models"
				>
					<RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
				</Button>

				<Button
					type="button"
					variant="secondary"
					onClick={onCheckUpdates}
					disabled={isChecking || remoteModelCount === 0 || isBusy}
					className="shrink-0 h-[34px] text-xs font-bold uppercase tracking-widest rounded-xl border border-secondary/30"
				>
					{isChecking ? "Checking..." : "Check Updates"}
				</Button>
			</div>
		</div>
	);
};
