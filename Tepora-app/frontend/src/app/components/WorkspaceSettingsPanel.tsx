import { useWorkspaceStore } from "../model/workspaceStore";

export function WorkspaceSettingsPanel() {
	const activeMode = useWorkspaceStore((state) => state.activeMode);
	const searchMode = useWorkspaceStore((state) => state.searchMode);
	const currentProjectId = useWorkspaceStore((state) => state.currentProjectId);

	return (
		<div className="flex h-full flex-col gap-6 overflow-hidden text-text-main">
			<div>
				<div className="font-serif text-[1.6rem] italic text-primary">Settings</div>
				<div className="mt-2 text-[0.72rem] uppercase tracking-[0.18em] text-text-muted">
					Current workspace state
				</div>
			</div>
			<div className="grid gap-3">
				<div className="rounded-[22px] border border-border bg-surface/40 p-4">
					<div className="text-[0.68rem] uppercase tracking-[0.16em] text-text-muted">
						Project
					</div>
					<div className="mt-2 text-sm text-text-main">{currentProjectId ?? "default"}</div>
				</div>
				<div className="rounded-[22px] border border-border bg-surface/40 p-4">
					<div className="text-[0.68rem] uppercase tracking-[0.16em] text-text-muted">
						Mode
					</div>
					<div className="mt-2 text-sm text-text-main">{activeMode}</div>
				</div>
				<div className="rounded-[22px] border border-border bg-surface/40 p-4">
					<div className="text-[0.68rem] uppercase tracking-[0.16em] text-text-muted">
						Search
					</div>
					<div className="mt-2 text-sm text-text-main">{searchMode}</div>
				</div>
			</div>
		</div>
	);
}
