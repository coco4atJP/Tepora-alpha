import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { WorkspaceExplorerPanel } from "./components/WorkspaceExplorerPanel";
import { WorkspacePreviewPanel } from "./components/WorkspacePreviewPanel";
import { WorkspaceSettingsPanel } from "./components/WorkspaceSettingsPanel";
import { useWorkspaceStore } from "./model/workspaceStore";
import { ChatScreen } from "../features/chat/screen/ChatScreen";
import { SessionSidebar } from "../features/session/screen/SessionSidebar";
import SetupScreen from "../features/setup/screen/SetupScreen";
import { SettingsScreen } from "../features/settings/screen/SettingsScreen";
import { useV2ConfigQuery } from "../features/settings/model/queries";
import { useRequirementsQuery } from "../features/setup/model/setupQueries";
import { AppShellLayout } from "../shared/ui/AppShellLayout";
import type { WorkspaceEntry } from "../shared/contracts";
import {
	useSelectWorkspaceProjectMutation,
	useSaveWorkspaceDocumentMutation,
	useWorkspaceDocumentQuery,
	useWorkspaceProjectsQuery,
	useWorkspaceTreeQuery,
} from "../shared/lib/workspaceQueries";

interface WorkspaceProps {
	isSettingsOpen?: boolean;
}

function useIsCompactLayout() {
	const [compact, setCompact] = useState(false);

	useEffect(() => {
		const update = () => setCompact(window.innerWidth < 1100);
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);

	return compact;
}

function Resizer({
	onDrag,
}: {
	onDrag: (deltaX: number) => void;
}) {
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			className="group relative w-3 cursor-col-resize"
			onMouseDown={(event) => {
				event.preventDefault();
				const startX = event.clientX;
				const handleMove = (moveEvent: MouseEvent) => {
					onDrag(moveEvent.clientX - startX);
				};
				const handleUp = () => {
					window.removeEventListener("mousemove", handleMove);
					window.removeEventListener("mouseup", handleUp);
				};
				window.addEventListener("mousemove", handleMove);
				window.addEventListener("mouseup", handleUp);
			}}
		>
			<div className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/60" />
		</div>
	);
}

export function Workspace({ isSettingsOpen = false }: WorkspaceProps) {
	const navigate = useNavigate();
	const compact = useIsCompactLayout();
	const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
	const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);
	const [leftWidth, setLeftWidth] = useState(26);
	const [centerWidth, setCenterWidth] = useState(30);

	const currentProjectId = useWorkspaceStore((state) => state.currentProjectId);
	const selectedDocumentPath = useWorkspaceStore((state) => state.selectedDocumentPath);
	const mobilePane = useWorkspaceStore((state) => state.mobilePane);
	const activeMode = useWorkspaceStore((state) => state.activeMode);
	const setCurrentProjectId = useWorkspaceStore((state) => state.setCurrentProjectId);
	const setSelectedDocumentPath = useWorkspaceStore((state) => state.setSelectedDocumentPath);
	const setMobilePane = useWorkspaceStore((state) => state.setMobilePane);

	const { data: config, isLoading: configLoading, refetch: refetchConfig } = useV2ConfigQuery();
	const { data: requirements, isLoading: reqLoading, refetch: refetchRequirements } =
		useRequirementsQuery();
	const projectsQuery = useWorkspaceProjectsQuery();
	const treeQuery = useWorkspaceTreeQuery(currentProjectId);
	const documentQuery = useWorkspaceDocumentQuery(currentProjectId, selectedDocumentPath);
	const selectProjectMutation = useSelectWorkspaceProjectMutation();
	const saveDocumentMutation = useSaveWorkspaceDocumentMutation(
		currentProjectId,
		selectedDocumentPath,
	);

	const isSetupCompleted = config?.app?.setup_completed === true;
	const shouldShowSetup =
		!reqLoading &&
		!configLoading &&
		(!requirements?.is_ready || requirements?.has_missing || !isSetupCompleted);

	useEffect(() => {
		if (!projectsQuery.data) {
			return;
		}
		setCurrentProjectId(projectsQuery.data.current_project_id);
	}, [projectsQuery.data, setCurrentProjectId]);

	const flatFilePaths = useMemo(() => {
		const collect = (entries: WorkspaceEntry[]): string[] =>
			entries.flatMap((entry) =>
				entry.kind === "file" ? [entry.path] : collect(entry.children),
			);
		return treeQuery.data?.tree ? collect(treeQuery.data.tree) : [];
	}, [treeQuery.data]);

	useEffect(() => {
		if (activeMode === "agent" && !selectedDocumentPath && flatFilePaths.length > 0) {
			setSelectedDocumentPath(flatFilePaths[0]);
		}
	}, [flatFilePaths, selectedDocumentPath, setSelectedDocumentPath, activeMode]);

	useEffect(() => {
		if (selectedDocumentPath && flatFilePaths.length > 0 && !flatFilePaths.includes(selectedDocumentPath)) {
			setSelectedDocumentPath(activeMode === "agent" ? (flatFilePaths[0] ?? null) : null);
		}
	}, [flatFilePaths, selectedDocumentPath, setSelectedDocumentPath, activeMode]);

	if (shouldShowSetup) {
		return (
			<SetupScreen
				onComplete={() => {
					void refetchRequirements();
					void refetchConfig();
				}}
			/>
		);
	}

	const displayProjects = activeMode === "search" ? [] : (projectsQuery.data?.projects ?? []);

	const displayTree = useMemo(() => {
		const rawTree = treeQuery.data?.tree ?? [];
		if (activeMode === "search") {
			const contextNode = rawTree.find((node) => node.name === "Context");
			return contextNode ? [contextNode] : [];
		}
		return rawTree;
	}, [treeQuery.data?.tree, activeMode]);

	const explorer = (
		<WorkspaceExplorerPanel
			projects={displayProjects}
			currentProjectId={currentProjectId}
			tree={displayTree}
			selectedPath={selectedDocumentPath}
			onSelectProject={(projectId) => {
				setCurrentProjectId(projectId);
				setSelectedDocumentPath(null);
				void selectProjectMutation.mutateAsync(projectId);
			}}
			onSelectPath={(path) => {
				setSelectedDocumentPath(path);
				if (compact) {
					setMobilePane("preview");
				}
			}}
		/>
	);

	const preview = (
		<WorkspacePreviewPanel
			document={documentQuery.data ?? null}
			selectedPath={selectedDocumentPath}
			isLoading={documentQuery.isLoading}
			onSave={async (content) => {
				await saveDocumentMutation.mutateAsync(content);
			}}
			onClose={() => setSelectedDocumentPath(null)}
		/>
	);

	const chat = (
		<div className="relative h-full min-h-0 overflow-hidden rounded-[28px] border border-[var(--glass-border)] bg-[var(--glass-bg)] shadow-[var(--glass-shadow)] backdrop-blur-xl transition-all duration-500 ease-out">
			{/* Inner subtle glow */}
			<div className="absolute top-0 left-1/4 w-1/2 h-px bg-gradient-to-r from-transparent via-gold-500/50 to-transparent" />
			<ChatScreen
				onOpenSettings={() => {
					navigate("/settings");
				}}
				onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
				onOpenRightSidebar={() => setIsRightSidebarOpen(true)}
			/>
		</div>
	);

	const desktopContent =
		activeMode === "chat" ? (
			<div className="flex h-full min-h-0 w-full p-4">
				<div className="min-w-0 flex-1">{chat}</div>
			</div>
		) : activeMode === "search" ? (
			<div className="flex h-full min-h-0 w-full p-4">
				<div style={{ width: `${leftWidth}%` }} className="relative min-w-0">
					<div className="absolute inset-0">
						{explorer}
					</div>
					{selectedDocumentPath && (
						<div className="absolute inset-0 z-20 animate-in fade-in zoom-in-95 duration-200">
							{preview}
						</div>
					)}
				</div>
				<Resizer
					onDrag={(deltaX) => setLeftWidth((current) => Math.max(24, Math.min(56, current + deltaX / 24)))}
				/>
				<div className="min-w-0 flex-1">{chat}</div>
			</div>
		) : (
			<div className="flex h-full min-h-0 w-full p-4">
				<div style={{ width: `${leftWidth}%` }} className="min-w-0">
					{explorer}
				</div>
				<Resizer
					onDrag={(deltaX) => setLeftWidth((current) => Math.max(18, Math.min(38, current + deltaX / 24)))}
				/>
				<div style={{ width: `${centerWidth}%` }} className="min-w-0">
					{preview}
				</div>
				<Resizer
					onDrag={(deltaX) =>
						setCenterWidth((current) => Math.max(24, Math.min(42, current + deltaX / 24)))
					}
				/>
				<div className="min-w-0 flex-1">{chat}</div>
			</div>
		);

	const compactContent = (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
				{[
					["files", "Files"],
					["preview", "Preview"],
					["chat", "Chat"],
				].map(([id, label]) => (
					<button
						key={id}
						type="button"
						onClick={() => setMobilePane(id as "files" | "preview" | "chat")}
						className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.14em] ${
							mobilePane === id
								? "border-primary/40 bg-primary/10 text-primary"
								: "border-border text-text-muted"
						}`}
					>
						{label}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 p-4">
				{mobilePane === "files" ? explorer : mobilePane === "preview" ? preview : chat}
			</div>
		</div>
	);

	return (
		<div className="relative h-screen w-screen overflow-hidden">
			<AppShellLayout
				leftSidebar={<SessionSidebar />}
				rightSidebar={<WorkspaceSettingsPanel />}
				isLeftSidebarOpen={isLeftSidebarOpen}
				isRightSidebarOpen={isRightSidebarOpen}
				onLeftSidebarClose={() => setIsLeftSidebarOpen(false)}
				onRightSidebarClose={() => setIsRightSidebarOpen(false)}
				mainContent={compact ? compactContent : desktopContent}
			/>
			<SettingsScreen
				isOpen={isSettingsOpen}
				onClose={() => {
					navigate("/");
				}}
			/>
		</div>
	);
}
