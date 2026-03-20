import React, { useEffect, useState } from "react";

export interface AppShellLayoutProps {
	leftSidebar?: React.ReactNode;
	rightSidebar?: React.ReactNode;
	mainContent: React.ReactNode;
	commandArea?: React.ReactNode;
	hideCommandArea?: boolean;
	isLeftSidebarOpen?: boolean;
	isRightSidebarOpen?: boolean;
	onLeftSidebarClose?: () => void;
	onRightSidebarClose?: () => void;
}

export const AppShellLayout: React.FC<AppShellLayoutProps> = ({
	leftSidebar,
	rightSidebar,
	mainContent,
	commandArea,
	hideCommandArea = false,
	isLeftSidebarOpen = false,
	isRightSidebarOpen = false,
	onLeftSidebarClose,
	onRightSidebarClose,
}) => {
	const [leftHoverOpen, setLeftHoverOpen] = useState(false);
	const [rightHoverOpen, setRightHoverOpen] = useState(false);

	useEffect(() => {
		if (isLeftSidebarOpen) {
			setLeftHoverOpen(false);
		}
	}, [isLeftSidebarOpen]);

	useEffect(() => {
		if (isRightSidebarOpen) {
			setRightHoverOpen(false);
		}
	}, [isRightSidebarOpen]);

	const showLeftSidebar = isLeftSidebarOpen || leftHoverOpen;
	const showRightSidebar = isRightSidebarOpen || rightHoverOpen;

	return (
		<div className="relative flex h-screen w-screen overflow-hidden bg-[image:var(--bg-gradient)] font-sans text-text-main">
			{leftSidebar ? (
				<button
					type="button"
					aria-label="Reveal history sidebar"
					className={`absolute inset-y-0 left-0 z-[35] w-4 bg-gradient-to-r from-primary/10 to-transparent transition-opacity ${
						showLeftSidebar ? "pointer-events-none opacity-0" : "opacity-100"
					}`}
					onMouseEnter={() => setLeftHoverOpen(true)}
				/>
			) : null}

			{rightSidebar ? (
				<button
					type="button"
					aria-label="Reveal agent sidebar"
					className={`absolute inset-y-0 right-0 z-[35] w-4 bg-gradient-to-l from-primary/10 to-transparent transition-opacity ${
						showRightSidebar ? "pointer-events-none opacity-0" : "opacity-100"
					}`}
					onMouseEnter={() => setRightHoverOpen(true)}
				/>
			) : null}

			{isLeftSidebarOpen ? (
				<div
					className="fixed inset-0 z-[45] bg-black/20 backdrop-blur-sm transition-opacity"
					onClick={onLeftSidebarClose}
					aria-hidden="true"
				/>
			) : null}

			{leftSidebar ? (
				<div className="pointer-events-none absolute inset-y-0 left-0 z-[50] flex">
					<div
						className={`pointer-events-auto absolute top-0 flex h-full w-[332px] max-w-[86vw] flex-col border-r border-border bg-bg/95 p-8 shadow-[24px_0_50px_rgba(59,38,20,0.08)] backdrop-blur-xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
							showLeftSidebar ? "left-0" : "left-[-348px]"
						}`}
						onMouseEnter={() => setLeftHoverOpen(true)}
						onMouseLeave={() => {
							if (!isLeftSidebarOpen) {
								setLeftHoverOpen(false);
							}
						}}
					>
						{leftSidebar}
					</div>
				</div>
			) : null}

			<div className="relative flex h-full w-full flex-1 flex-col">
				<main className="relative flex-1 overflow-hidden">{mainContent}</main>
				{commandArea ? (
					<div
						className={`absolute bottom-10 left-1/2 z-50 w-full max-w-[820px] -translate-x-1/2 px-5 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
							hideCommandArea
								? "pointer-events-none translate-y-5 opacity-0"
								: "translate-y-0 opacity-100"
						}`}
					>
						{commandArea}
					</div>
				) : null}
			</div>

			{isRightSidebarOpen ? (
				<div
					className="fixed inset-0 z-[45] bg-black/20 backdrop-blur-sm transition-opacity"
					onClick={onRightSidebarClose}
					aria-hidden="true"
				/>
			) : null}

			{rightSidebar ? (
				<div className="pointer-events-none absolute inset-y-0 right-0 z-[50] flex">
					<div
						className={`pointer-events-auto absolute top-0 flex h-full w-[360px] max-w-[90vw] flex-col border-l border-border bg-bg/95 p-8 shadow-[-24px_0_50px_rgba(59,38,20,0.08)] backdrop-blur-xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
							showRightSidebar ? "right-0" : "right-[-380px]"
						}`}
						onMouseEnter={() => setRightHoverOpen(true)}
						onMouseLeave={() => {
							if (!isRightSidebarOpen) {
								setRightHoverOpen(false);
							}
						}}
					>
						{rightSidebar}
					</div>
				</div>
			) : null}
		</div>
	);
};
