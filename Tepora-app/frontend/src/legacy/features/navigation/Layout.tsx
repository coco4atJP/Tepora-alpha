import { AlertTriangle, Bot, MessageSquare, Search, Settings as SettingsIcon, ShieldAlert, X } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import DynamicBackground from "../../components/ui/DynamicBackground";
import { useTheme } from "../../context/ThemeContext";
import { useSettingsState } from "../../context/SettingsContext";
import { useChatStore, useSocketConnectionStore } from "../../stores";
import type { Attachment, ChatMode } from "../../../types";
import { logger } from "../../../utils/logger";
import { detectPii, isTextLikeFile } from "../../../utils/piiDetection";
import AgentStatus from "../chat/AgentStatus";
import DialControl from "../chat/DialControl";
import RagContextPanel from "../chat/RagContextPanel";
import SystemStatusPanel from "../chat/SystemStatusPanel";
import { SessionHistoryModal } from "../session/components/SessionHistoryModal";
import SettingsDialog from "../settings/components/SettingsDialog";

interface MobileNavButtonProps {
	mode: ChatMode;
	icon: React.ElementType;
	label: string;
	isActive: boolean;
	onClick: (mode: ChatMode) => void;
}

interface PendingAttachmentReview {
	attachments: Attachment[];
}

const MobileNavButton: React.FC<MobileNavButtonProps> = ({
	mode,
	icon: Icon,
	label,
	isActive,
	onClick,
}) => (
	<Button
		variant={isActive ? "primary" : "ghost"}
		onClick={() => onClick(mode)}
		className={`flex flex-col items-center justify-center p-2 h-auto w-full rounded-lg transition-all duration-300 relative overflow-hidden hover:bg-white/5`}
	>
		{isActive && (
			<div className="absolute inset-0 bg-gradient-to-t from-gold-500/10 to-transparent animate-fade-in pointer-events-none" />
		)}
		<Icon size={20} className={`relative z-10 transition-transform duration-300 ${isActive ? "drop-shadow-[0_0_8px_rgba(255,215,0,0.5)] scale-110" : "scale-100 opacity-70"}`} />
		<span className={`text-[10px] mt-1 font-medium tracking-wide relative z-10 transition-colors duration-300 ${isActive ? "text-gold-400" : "opacity-70"}`}>
			{label}
		</span>
		{isActive && (
			<div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-t-full bg-gold-400 shadow-[0_0_8px_rgba(255,215,0,0.8)] animate-slide-up pointer-events-none" />
		)}
	</Button>
);

interface MobileOverlayPanelProps {
	title: string;
	closeLabel: string;
	onClose: () => void;
	children: React.ReactNode;
}

const MobileOverlayPanel: React.FC<MobileOverlayPanelProps> = ({
	title,
	closeLabel,
	onClose,
	children,
}) => (
	<div className="absolute inset-x-3 top-3 bottom-[5.5rem] z-20 lg:hidden">
		<div className="h-full rounded-2xl glass-panel border border-white/10 shadow-2xl overflow-hidden flex flex-col">
			<div className="shrink-0 px-3 py-2 border-b border-white/10 flex items-center justify-between">
				<span className="text-xs font-semibold tracking-wider uppercase text-gold-200">
					{title}
				</span>
				<Button
					variant="ghost"
					size="icon"
					className="w-8 h-8 rounded-full"
					onClick={onClose}
					aria-label={closeLabel}
				>
					<X size={16} />
				</Button>
			</div>
			<div className="flex-1 min-h-0 p-3 pt-2">{children}</div>
		</div>
	</div>
);

const readFileAsBase64 = (file: File): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") {
				const commaIndex = reader.result.indexOf(",");
				if (commaIndex === -1) {
					reject(new Error("Invalid data URL"));
					return;
				}
				resolve(reader.result.slice(commaIndex + 1));
			} else {
				reject(new Error("Failed to read file as string"));
			}
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});

const readFileAsText = (file: File): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") {
				resolve(reader.result);
			} else {
				reject(new Error("Failed to read text file"));
			}
		};
		reader.onerror = reject;
		reader.readAsText(file);
	});

const Layout: React.FC = () => {
	const [currentMode, setCurrentMode] = useState<ChatMode>("chat");
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [isHistoryOpen, setIsHistoryOpen] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [skipWebSearch, setSkipWebSearch] = useState(false);
	const [pendingAttachmentReview, setPendingAttachmentReview] = useState<PendingAttachmentReview | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { t } = useTranslation();
	const { activeTheme } = useTheme();
	const { config } = useSettingsState();
	const isTepora = activeTheme === "tepora";
	const setChatError = useChatStore((state) => state.setError);
	const privacyConfig = config?.privacy as
		| {
				allow_web_search: boolean;
				redact_pii: boolean;
				isolation_mode?: boolean;
				url_denylist?: string[];
				url_policy_preset?: "strict" | "balanced" | "permissive";
				lockdown?: { enabled?: boolean | null };
		  }
		| undefined;

	const isWebSearchAllowed = privacyConfig?.allow_web_search ?? false;
	const lockdownEnabled = privacyConfig?.lockdown?.enabled ?? false;
	const actualSkipWebSearch = !isWebSearchAllowed || skipWebSearch;

	const searchResults = useChatStore((state) => state.searchResults);
	const memoryStats = useChatStore((state) => state.memoryStats);
	const activityLog = useChatStore((state) => state.activityLog);
	const isConnected = useSocketConnectionStore((state) => state.isConnected);

	const handleModeChange = useCallback((mode: ChatMode) => {
		setCurrentMode(mode);
	}, []);

	const appendAttachments = useCallback((nextAttachments: Attachment[]) => {
		setAttachments((prev) => [...prev, ...nextAttachments]);
		if (fileInputRef.current) fileInputRef.current.value = "";
	}, []);

	const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		if (lockdownEnabled) {
			setChatError("Privacy Lockdown is enabled; attachments are blocked.");
			if (fileInputRef.current) fileInputRef.current.value = "";
			return;
		}
		if (!e.target.files || e.target.files.length === 0) {
			return;
		}

		const nextAttachments: Attachment[] = [];
		for (let i = 0; i < e.target.files.length; i += 1) {
			const file = e.target.files[i];
			try {
				const textLike = isTextLikeFile(file.name, file.type);
				const content = textLike ? await readFileAsText(file) : await readFileAsBase64(file);
				const piiFindings = textLike ? detectPii(content) : [];
				nextAttachments.push({
					name: file.name,
					content,
					type: file.type || (textLike ? "text/plain" : "application/octet-stream"),
					piiFindings,
				});
			} catch (err) {
				logger.error("Failed to read file:", file.name, err);
			}
		}

		if (nextAttachments.some((attachment) => (attachment.piiFindings?.length ?? 0) > 0)) {
			setPendingAttachmentReview({ attachments: nextAttachments });
			if (fileInputRef.current) fileInputRef.current.value = "";
			return;
		}

		appendAttachments(nextAttachments);
	};

	const handleAddAttachment = useCallback(() => {
		if (lockdownEnabled) {
			setChatError("Privacy Lockdown is enabled; attachments are blocked.");
			return;
		}
		fileInputRef.current?.click();
	}, [lockdownEnabled, setChatError]);

	const handleRemoveAttachment = useCallback((index: number) => {
		setAttachments((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const clearAttachments = useCallback(() => {
		setAttachments([]);
	}, []);

	const confirmAttachmentReview = useCallback(() => {
		if (!pendingAttachmentReview) return;
		appendAttachments(
			pendingAttachmentReview.attachments.map((attachment) => ({
				...attachment,
				piiConfirmed: (attachment.piiFindings?.length ?? 0) > 0,
			})),
		);
		setPendingAttachmentReview(null);
	}, [appendAttachments, pendingAttachmentReview]);

	const dismissAttachmentReview = useCallback(() => {
		setPendingAttachmentReview(null);
		if (fileInputRef.current) fileInputRef.current.value = "";
	}, []);

	const pendingFindings = useMemo(() => {
		if (!pendingAttachmentReview) return [];
		return pendingAttachmentReview.attachments.flatMap((attachment) =>
			(attachment.piiFindings ?? []).map((finding) => ({
				...finding,
				attachmentName: attachment.name,
			})),
		);
	}, [pendingAttachmentReview]);

	return (
		<div className="flex flex-col h-[100dvh] w-full overflow-hidden relative font-sans bg-theme-bg text-theme-text transition-colors duration-300">
			<input
				type="file"
				ref={fileInputRef}
				className="hidden"
				onChange={handleFileSelect}
				multiple
				accept=".txt,.md,.json,.xml,.csv,.log,.py,.js,.ts,.tsx,.jsx,.html,.css,.yml,.yaml,.toml,.ini,.cfg,.conf,.sh,.bat,.ps1,.c,.cpp,.h,.hpp,.java,.go,.rs,.rb,.php,.sql,.r,.m,.swift,.kt"
			/>

			<Modal
				isOpen={!!pendingAttachmentReview}
				onClose={dismissAttachmentReview}
				title={t("attachments.pii.title", "添付ファイルに機密情報の可能性があります")}
				size="lg"
			>
				<div className="p-6 space-y-5">
					<div className="flex items-start gap-3 text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
						<ShieldAlert className="w-5 h-5 mt-0.5 shrink-0 text-amber-300" />
						<div>
							<p className="font-medium text-amber-100">
								{t("attachments.pii.body", "メールアドレス、電話番号、APIキー、トークン、カード番号らしき文字列を検知しました。確認なしでは送信しません。")}
							</p>
							<p className="text-sm text-amber-200/80 mt-1">
								{t("attachments.pii.sub", "許可すると、この添付には PII 確認済みフラグを付けて送信します。")}
							</p>
						</div>
					</div>

					<div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
						{pendingFindings.map((finding, index) => (
							<div key={`${finding.attachmentName}-${finding.category}-${finding.preview}-${index}`} className="rounded-lg border border-white/10 bg-black/20 px-4 py-3">
								<div className="flex items-center gap-2 text-sm text-white">
									<AlertTriangle className="w-4 h-4 text-amber-300" />
									<span className="font-medium">{finding.attachmentName}</span>
								</div>
								<div className="mt-2 text-xs text-gray-300 flex flex-wrap gap-2">
									<span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 uppercase tracking-wide">
										{finding.category}
									</span>
									<code className="text-amber-200">{finding.preview}</code>
								</div>
							</div>
						))}
					</div>

					<div className="flex gap-3 pt-2">
						<Button variant="secondary" className="flex-1" onClick={dismissAttachmentReview}>
							{t("common.cancel", "キャンセル")}
						</Button>
						<Button variant="primary" className="flex-1" onClick={confirmAttachmentReview}>
							{t("attachments.pii.confirm", "確認して添付する")}
						</Button>
					</div>
				</div>
			</Modal>

			{isTepora && <DynamicBackground />}
			<div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
				{isTepora && (
					<>
						<div className="absolute inset-0 bg-gradient-to-b from-black/80 via-[#100a08]/70 to-black/90"></div>
						<div className="absolute inset-0 bg-gradient-to-tr from-gold-500/10 via-transparent to-tea-500/5 opacity-60"></div>
						<div className="absolute top-[-20%] left-[-10%] w-[80vw] h-[80vw] bg-[radial-gradient(circle,rgba(120,60,20,0.1)_0%,transparent_50%)] pointer-events-none animate-slow-breathe" style={{ animationDelay: '0s' }}></div>
						<div className="absolute bottom-[-20%] right-[-10%] w-[70vw] h-[70vw] bg-[radial-gradient(circle,rgba(60,30,20,0.1)_0%,transparent_50%)] pointer-events-none animate-slow-breathe" style={{ animationDelay: '-7.5s', animationDuration: '20s' }}></div>
					</>
				)}
			</div>

			<div className="relative z-10 flex-1 w-full px-2 md:px-4 py-2 md:py-4">
				<div className="mx-auto h-full w-full max-w-[1440px] grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-3 lg:gap-6 min-h-0">
					<div className="h-full flex flex-col min-h-0 order-1 w-full overflow-hidden">
						<div className="flex-1 glass-tepora rounded-2xl md:rounded-3xl overflow-hidden relative shadow-2xl border border-white/10 ring-1 ring-white/5 min-h-0 flex flex-col">
							<div className="absolute inset-0 z-0 flex flex-col">
								<Outlet
									context={{
										currentMode,
										attachments,
										onFileSelect: handleAddAttachment,
										onRemoveAttachment: handleRemoveAttachment,
										clearAttachments,
										skipWebSearch: actualSkipWebSearch,
										onOpenHistory: () => setIsHistoryOpen(true),
										onOpenSettings: () => setIsSettingsOpen(true),
									}}
								/>
							</div>

							{currentMode === "search" && (
								<MobileOverlayPanel
									title={t("dial.search")}
									closeLabel={t("common.close")}
									onClose={() => setCurrentMode("chat")}
								>
									<RagContextPanel
										attachments={attachments}
										onAddAttachment={handleAddAttachment}
										onRemoveAttachment={handleRemoveAttachment}
										searchResults={searchResults}
										skipWebSearch={actualSkipWebSearch}
										onToggleWebSearch={() => setSkipWebSearch(!skipWebSearch)}
										webSearchAllowed={isWebSearchAllowed}
									/>
								</MobileOverlayPanel>
							)}

							{currentMode === "agent" && (
								<MobileOverlayPanel
									title={t("dial.agent")}
									closeLabel={t("common.close")}
									onClose={() => setCurrentMode("chat")}
								>
									<AgentStatus activityLog={activityLog} />
								</MobileOverlayPanel>
							)}
						</div>
					</div>

					<div className="hidden lg:grid grid-rows-[auto_minmax(0,1fr)_auto] gap-4 min-h-0 order-2">
						<div className="glass-panel rounded-3xl p-4 border border-white/10 shadow-xl shrink-0">
							<div className="relative flex justify-center">
								<div className="absolute inset-0 bg-gold-500/20 blur-3xl rounded-full"></div>
								<DialControl
									currentMode={currentMode}
									onModeChange={setCurrentMode}
									onSettingsClick={() => setIsSettingsOpen(true)}
								/>
							</div>
						</div>

						<div className="min-h-0 overflow-hidden flex flex-col">
							{currentMode === "search" && (
								<RagContextPanel
									attachments={attachments}
									onAddAttachment={handleAddAttachment}
									onRemoveAttachment={handleRemoveAttachment}
									searchResults={searchResults}
									skipWebSearch={actualSkipWebSearch}
									onToggleWebSearch={() => setSkipWebSearch(!skipWebSearch)}
									webSearchAllowed={isWebSearchAllowed}
								/>
							)}
							{currentMode === "agent" && <AgentStatus activityLog={activityLog} />}
							{currentMode === "chat" && (
								<div className="h-full glass-panel rounded-3xl p-6 border border-white/10 flex flex-col justify-center text-center">
									<p className="text-xs font-semibold uppercase tracking-wider text-gold-300/80">
										{t("dial.chat")}
									</p>
									<p className="mt-3 text-sm text-theme-subtext leading-relaxed">
										{t("chat.input.system_ready_hint", "Select a mode and start chatting.")}
									</p>
								</div>
							)}
						</div>

						<SystemStatusPanel isConnected={isConnected} memoryStats={memoryStats} />
					</div>
				</div>
			</div>

			<div className="lg:hidden relative z-20 glass-panel border-t border-white/10 pb-safe">
				<div className="flex justify-around items-center p-3">
					<MobileNavButton
						mode="chat"
						icon={MessageSquare}
						label={t("dial.chat")}
						isActive={currentMode === "chat"}
						onClick={handleModeChange}
					/>
					<MobileNavButton
						mode="search"
						icon={Search}
						label={t("dial.search")}
						isActive={currentMode === "search"}
						onClick={handleModeChange}
					/>
					<MobileNavButton
						mode="agent"
						icon={Bot}
						label={t("dial.agent")}
						isActive={currentMode === "agent"}
						onClick={handleModeChange}
					/>

					<Button
						variant="ghost"
						onClick={() => setIsSettingsOpen(true)}
						className="flex flex-col items-center justify-center p-2 h-auto w-full rounded-lg text-gray-400 hover:text-gray-200"
					>
						<SettingsIcon size={20} />
						<span className="text-[10px] mt-1 font-medium tracking-wide">
							{t("common.settings")}
						</span>
					</Button>
				</div>
			</div>

			<SettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
			<SessionHistoryModal isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} />
		</div>
	);
};

export default Layout;

