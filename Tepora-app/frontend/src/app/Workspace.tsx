import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentPanel } from "../features/agent/screen/AgentPanel";
import { ChatScreen } from "../features/chat/screen/ChatScreen";
import { SessionSidebar } from "../features/session/screen/SessionSidebar";
import SetupScreen from "../features/setup/screen/SetupScreen";
import { SettingsScreen } from "../features/settings/screen/SettingsScreen";
import { useV2ConfigQuery } from "../features/settings/model/queries";
import { useRequirementsQuery } from "../features/setup/model/setupQueries";
import { AppShellLayout } from "../shared/ui/AppShellLayout";

interface WorkspaceProps {
	isSettingsOpen?: boolean;
}

export function Workspace({ isSettingsOpen = false }: WorkspaceProps) {
	const navigate = useNavigate();
	const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
	const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);

	// --- Setup detection (ported from legacy/App.tsx) ---
	const { data: config, isLoading: configLoading, refetch: refetchConfig } = useV2ConfigQuery();
	const { data: requirements, isLoading: reqLoading, refetch: refetchRequirements } = useRequirementsQuery();

	const isSetupCompleted = config?.app?.setup_completed === true;
	const shouldShowSetup =
		!reqLoading &&
		!configLoading &&
		(!requirements?.is_ready || requirements?.has_missing || !isSetupCompleted);

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

	return (
		<div className="relative h-screen w-screen overflow-hidden">
			<AppShellLayout
				leftSidebar={<SessionSidebar />}
				rightSidebar={<AgentPanel />}
				isLeftSidebarOpen={isLeftSidebarOpen}
				isRightSidebarOpen={isRightSidebarOpen}
				onLeftSidebarClose={() => setIsLeftSidebarOpen(false)}
				onRightSidebarClose={() => setIsRightSidebarOpen(false)}
				mainContent={
					<ChatScreen
						onOpenSettings={() => {
							navigate("/settings");
						}}
						onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
						onOpenRightSidebar={() => setIsRightSidebarOpen(true)}
					/>
				}
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
