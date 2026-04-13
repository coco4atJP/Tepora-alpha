import { useState } from "react";
import type { WorkspaceEntry, WorkspaceProject } from "../../shared/contracts";
import { ChevronRight, ChevronDown, Folder, FileText, FileCode, FileJson, File as FileIcon } from "lucide-react";

interface WorkspaceExplorerPanelProps {
	projects: WorkspaceProject[];
	currentProjectId: string | null;
	tree: WorkspaceEntry[];
	selectedPath: string | null;
	onSelectProject: (projectId: string) => void;
	onSelectPath: (path: string) => void;
}

function getFileIcon(filename: string) {
	const ext = filename.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'md': 
		case 'txt': 
			return <FileText className="mr-2 h-4 w-4 shrink-0 opacity-70" />;
		case 'js': 
		case 'ts': 
		case 'tsx': 
		case 'jsx': 
		case 'rs': 
			return <FileCode className="mr-2 h-4 w-4 shrink-0 opacity-70" />;
		case 'json': 
			return <FileJson className="mr-2 h-4 w-4 shrink-0 opacity-70" />;
		default: 
			return <FileIcon className="mr-2 h-4 w-4 shrink-0 opacity-70" />;
	}
}

function TreeNode({
	entry,
	selectedPath,
	onSelectPath,
}: {
	entry: WorkspaceEntry;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
}) {
	const [isExpanded, setIsExpanded] = useState(true);

	if (entry.kind === "file") {
		return (
			<button
				type="button"
				onClick={() => onSelectPath(entry.path)}
				className={`flex w-full items-center rounded-xl px-2 py-1.5 text-left text-sm transition-colors ${
					selectedPath === entry.path
						? "bg-primary/10 text-primary font-medium"
						: "text-text-muted hover:bg-white/50 hover:text-text-main"
				}`}
				title={entry.name}
			>
				{getFileIcon(entry.name)}
				<span className="truncate">{entry.name}</span>
			</button>
		);
	}

	return (
		<div className="mb-0.5">
			<button
				type="button"
				onClick={() => setIsExpanded(!isExpanded)}
				className="flex w-full items-center rounded-xl px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-[0.12em] text-text-muted/80 transition-colors hover:bg-white/40"
				title={entry.name}
			>
				{isExpanded ? (
					<ChevronDown className="mr-1 h-3.5 w-3.5 shrink-0 opacity-60" />
				) : (
					<ChevronRight className="mr-1 h-3.5 w-3.5 shrink-0 opacity-60" />
				)}
				<Folder className="mr-1.5 h-3.5 w-3.5 shrink-0 opacity-50" />
				<span className="truncate">{entry.name}</span>
			</button>
			{isExpanded && (
				<div className="ml-4 mt-0.5 flex flex-col gap-[2px] border-l border-border/60 pl-1.5">
					{entry.children.map((child) => (
						<TreeNode
							key={child.path}
							entry={child}
							selectedPath={selectedPath}
							onSelectPath={onSelectPath}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function WorkspaceExplorerPanel({
	projects,
	currentProjectId,
	tree,
	selectedPath,
	onSelectProject,
	onSelectPath,
}: WorkspaceExplorerPanelProps) {
	return (
		<div className="relative flex h-full flex-col gap-6 overflow-hidden rounded-[28px] border border-[var(--glass-border)] bg-[var(--glass-bg)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-xl transition-all duration-500 ease-out">
			{/* Inner subtle glow */}
			<div className="absolute top-0 left-1/4 w-1/2 h-px bg-gradient-to-r from-transparent via-gold-500/50 to-transparent" />
			<div className="relative z-10 w-full">
				<div className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-primary/70">
					Projects
				</div>
				<div className="mt-3 flex flex-wrap gap-2">
					{projects.map((project) => (
						<button
							key={project.id}
							type="button"
							onClick={() => onSelectProject(project.id)}
							className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.14em] transition-colors ${
								project.id === currentProjectId
									? "border-primary/40 bg-primary/10 text-primary"
									: "border-border text-text-muted hover:border-primary/20 hover:text-text-main"
							}`}
						>
							{project.name}
						</button>
					))}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto pr-1 pb-2">
				<div className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-primary/70">
					Workspace
				</div>
				<div className="flex flex-col gap-[2px]">
					{tree.map((entry) => (
						<TreeNode
							key={entry.path}
							entry={entry}
							selectedPath={selectedPath}
							onSelectPath={onSelectPath}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
