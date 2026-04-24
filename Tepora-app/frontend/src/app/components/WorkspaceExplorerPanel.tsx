import { useState, useRef, useEffect } from "react";
import type { WorkspaceEntry, WorkspaceProject } from "../../shared/contracts";
import { ChevronRight, ChevronDown, Folder, FileText, FileCode, FileJson, File as FileIcon, FilePlus, FolderPlus, Edit2, Trash2 } from "lucide-react";
import {
	useCreateWorkspaceDirectoryMutation,
	useDeleteWorkspacePathMutation,
	useRenameWorkspacePathMutation,
	useCreateWorkspaceDocumentMutation,
} from "../../shared/lib/workspaceQueries";

interface WorkspaceExplorerPanelProps {
	projects: WorkspaceProject[];
	currentProjectId: string | null;
	tree: WorkspaceEntry[];
	selectedPath: string | null;
	onSelectProject: (projectId: string) => void;
	onSelectPath: (path: string) => void;
}

interface ExplorerActions {
	createFile: (parentPath: string, name: string) => Promise<void>;
	createFolder: (parentPath: string, name: string) => Promise<void>;
	renamePath: (oldPath: string, newPath: string) => Promise<void>;
	deletePath: (path: string) => Promise<void>;
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
	actions,
}: {
	entry: WorkspaceEntry;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
	actions: ExplorerActions;
}) {
	const [isExpanded, setIsExpanded] = useState(true);
	const [isHovered, setIsHovered] = useState(false);
	const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
	const [isRenaming, setIsRenaming] = useState(false);
	const [inputValue, setInputValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if ((creatingType || isRenaming) && inputRef.current) {
			inputRef.current.focus();
		}
	}, [creatingType, isRenaming]);

	const handleActionSubmit = async () => {
		if (!inputValue.trim()) {
			setCreatingType(null);
			setIsRenaming(false);
			return;
		}
		
		try {
			if (creatingType === 'file') {
				await actions.createFile(entry.path, inputValue);
				setIsExpanded(true);
			} else if (creatingType === 'folder') {
				await actions.createFolder(entry.path, inputValue);
				setIsExpanded(true);
			} else if (isRenaming) {
				const parentPath = entry.path.split('/').slice(0, -1).join('/');
				const newPath = parentPath ? `${parentPath}/${inputValue}` : inputValue;
				await actions.renamePath(entry.path, newPath);
			}
		} catch (error) {
			console.error("Action failed:", error);
		}
		
		setCreatingType(null);
		setIsRenaming(false);
		setInputValue("");
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			void handleActionSubmit();
		} else if (e.key === 'Escape') {
			setCreatingType(null);
			setIsRenaming(false);
			setInputValue("");
		}
	};

	const handleDelete = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (window.confirm(`Are you sure you want to delete '${entry.name}'?`)) {
			void actions.deletePath(entry.path);
		}
	};

	if (isRenaming) {
		return (
			<div className="flex w-full items-center rounded-xl px-2 py-1.5 bg-primary/5">
				{entry.kind === "file" ? getFileIcon(entry.name) : <Folder className="mr-1.5 h-3.5 w-3.5 shrink-0 opacity-50" />}
				<input
					ref={inputRef}
					type="text"
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					onKeyDown={handleKeyDown}
					onBlur={() => void handleActionSubmit()}
					className="flex-1 bg-transparent text-sm outline-none text-text-main"
				/>
			</div>
		);
	}

	if (entry.kind === "file") {
		return (
			<div 
				className="group relative flex w-full items-center rounded-xl px-2 py-1.5 transition-colors"
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => setIsHovered(false)}
			>
				<button
					type="button"
					onClick={() => onSelectPath(entry.path)}
					className={`flex flex-1 items-center text-left text-sm transition-colors ${
						selectedPath === entry.path
							? "text-primary font-medium"
							: "text-text-muted hover:text-text-main"
					}`}
					title={entry.name}
				>
					{getFileIcon(entry.name)}
					<span className="truncate">{entry.name}</span>
				</button>

				{isHovered && (
					<div className="absolute right-2 flex items-center gap-1 bg-[var(--glass-bg)] px-1 backdrop-blur-sm rounded-md">
						<button onClick={() => { setIsRenaming(true); setInputValue(entry.name); }} className="p-1 text-text-muted hover:text-primary transition-colors" title="Rename">
							<Edit2 className="h-3.5 w-3.5" />
						</button>
						<button onClick={handleDelete} className="p-1 text-text-muted hover:text-red-400 transition-colors" title="Delete">
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="mb-0.5">
			<div 
				className="group relative flex w-full items-center rounded-xl px-2 py-1.5 transition-colors hover:bg-white/40"
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => setIsHovered(false)}
			>
				<button
					type="button"
					onClick={() => setIsExpanded(!isExpanded)}
					className="flex flex-1 items-center text-left text-xs font-semibold uppercase tracking-[0.12em] text-text-muted/80"
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

				{isHovered && (
					<div className="absolute right-2 flex items-center gap-1 bg-[var(--glass-bg)] px-1 backdrop-blur-sm rounded-md">
						<button onClick={() => setCreatingType('file')} className="p-1 text-text-muted hover:text-primary transition-colors" title="New File">
							<FilePlus className="h-3.5 w-3.5" />
						</button>
						<button onClick={() => setCreatingType('folder')} className="p-1 text-text-muted hover:text-primary transition-colors" title="New Folder">
							<FolderPlus className="h-3.5 w-3.5" />
						</button>
						<button onClick={() => { setIsRenaming(true); setInputValue(entry.name); }} className="p-1 text-text-muted hover:text-primary transition-colors" title="Rename">
							<Edit2 className="h-3.5 w-3.5" />
						</button>
						<button onClick={handleDelete} className="p-1 text-text-muted hover:text-red-400 transition-colors" title="Delete">
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					</div>
				)}
			</div>
			
			{isExpanded && (
				<div className="ml-4 mt-0.5 flex flex-col gap-[2px] border-l border-border/60 pl-1.5">
					{creatingType && (
						<div className="flex w-full items-center rounded-xl px-2 py-1.5 bg-primary/5">
							{creatingType === "file" ? <FileIcon className="mr-2 h-4 w-4 shrink-0 opacity-50" /> : <Folder className="mr-1.5 h-3.5 w-3.5 shrink-0 opacity-50" />}
							<input
								ref={inputRef}
								type="text"
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								onKeyDown={handleKeyDown}
								onBlur={() => void handleActionSubmit()}
								className="flex-1 bg-transparent text-sm outline-none text-text-main"
								placeholder={`New ${creatingType}...`}
							/>
						</div>
					)}
					{entry.children.map((child) => (
						<TreeNode
							key={child.path}
							entry={child}
							selectedPath={selectedPath}
							onSelectPath={onSelectPath}
							actions={actions}
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
	const createDirMutation = useCreateWorkspaceDirectoryMutation(currentProjectId);
	const renameMutation = useRenameWorkspacePathMutation(currentProjectId);
	const deleteMutation = useDeleteWorkspacePathMutation(currentProjectId);
	const createDocMutation = useCreateWorkspaceDocumentMutation(currentProjectId);

	const actions: ExplorerActions = {
		createFile: async (parentPath: string, name: string) => {
			const newPath = `${parentPath}/${name}`;
			await createDocMutation.mutateAsync(newPath);
		},
		createFolder: async (parentPath: string, name: string) => {
			const newPath = `${parentPath}/${name}`;
			await createDirMutation.mutateAsync(newPath);
		},
		renamePath: async (oldPath: string, newPath: string) => {
			await renameMutation.mutateAsync({ oldPath, newPath });
		},
		deletePath: async (path: string) => {
			await deleteMutation.mutateAsync(path);
		}
	};

	return (
		<div className="relative flex h-full flex-col gap-6 overflow-hidden rounded-[28px] border border-[var(--glass-border)] bg-[var(--glass-bg)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-xl transition-all duration-500 ease-out">
			{/* Inner subtle glow */}
			<div className="absolute top-0 left-1/4 w-1/2 h-px bg-gradient-to-r from-transparent via-gold-500/50 to-transparent" />
			{projects.length > 0 && (
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
			)}

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
							actions={actions}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
