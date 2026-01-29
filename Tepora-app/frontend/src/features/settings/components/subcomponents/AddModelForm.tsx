import { open } from "@tauri-apps/plugin-dialog";
import {
	AlertTriangle,
	CheckCircle,
	Database,
	Download,
	FileUp,
	Loader2,
	XCircle,
} from "lucide-react";
import React, { type ChangeEvent, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, apiClient } from "../../../../utils/api-client";
import { FormGroup, FormInput } from "../SettingsComponents";

interface AddModelFormProps {
	onModelAdded: () => void;
}

interface LocalFile {
	name: string;
	path: string;
	size?: number;
}

export const AddModelForm: React.FC<AddModelFormProps> = ({ onModelAdded }) => {
	const { t } = useTranslation();
	const [mode, setMode] = useState<"hf" | "local">("hf");
	const [isExpanded, setIsExpanded] = useState(false);

	// HF State
	const [repoId, setRepoId] = useState("");
	const [filename, setFilename] = useState("");
	const [checkStatus, setCheckStatus] = useState<
		"idle" | "checking" | "valid" | "invalid"
	>("idle");
	const [downloading, setDownloading] = useState(false);

	// Local State
	const [dragActive, setDragActive] = useState(false);
	const [localFile, setLocalFile] = useState<LocalFile | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Consent Warning State
	const [showConsentDialog, setShowConsentDialog] = useState(false);
	const [consentWarnings, setConsentWarnings] = useState<string[]>([]);

	const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleCheck = useCallback(async (r: string, f: string) => {
		if (!r || !f) {
			setCheckStatus("idle");
			return;
		}

		setCheckStatus("checking");
		try {
			const data = await apiClient.post<{ exists: boolean }>(
				"api/setup/model/check",
				{
					repo_id: r,
					filename: f,
				},
			);
			setCheckStatus(data.exists ? "valid" : "invalid");
		} catch (e) {
			console.error(e);
			setCheckStatus("invalid");
		}
	}, []);

	const handleInput = (field: "repo" | "file", value: string) => {
		if (field === "repo") setRepoId(value);
		else setFilename(value);

		const newRepo = field === "repo" ? value : repoId;
		const newFile = field === "file" ? value : filename;

		if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);

		if (newRepo && newFile) {
			checkTimeoutRef.current = setTimeout(
				() => handleCheck(newRepo, newFile),
				800,
			);
		} else {
			setCheckStatus("idle");
		}
	};

	const [selectedRole, setSelectedRole] = useState("text");

	// Dialog Handler
	const handleOpenDialog = async () => {
		try {
			const selected = await open({
				multiple: false,
				filters: [
					{
						name: "GGUF Models",
						extensions: ["gguf"],
					},
				],
			});

			if (selected && typeof selected === "string") {
				// Provide a fallback name if parsing fails, though path usually has separators
				const name = selected.split(/[\\/]/).pop() || selected;
				setLocalFile({
					name,
					path: selected,
					// Size is unknown unless we use fs stat, but that requires extra permissions/calls.
					// UI handles missing size gracefully.
				});
			}
		} catch (e) {
			console.error("Failed to open dialog:", e);
		}
	};

	// Drag and Drop
	const handleDrag = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (e.type === "dragenter" || e.type === "dragover") {
			setDragActive(true);
		} else if (e.type === "dragleave") {
			setDragActive(false);
		}
	};

	const handleDrop = async (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setDragActive(false);

		if (e.dataTransfer.files?.[0]) {
			const file = e.dataTransfer.files[0];
			if (file.name.endsWith(".gguf")) {
				// Attempt to get path from File object (Tauri/Electron extension)
				// @ts-expect-error - path property might exist
				const path = file.path;
				if (path) {
					setLocalFile({
						name: file.name,
						path: path,
						size: file.size,
					});
				} else {
					alert(
						t("settings.sections.models.add_modal.dnd_no_path"),
					);
				}
			} else {
				alert(
					t("settings.sections.models.add_modal.invalid_file"),
				);
			}
		}
	};

	const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
		if (e.target.files?.[0]) {
			const file = e.target.files[0];
			if (file.name.endsWith(".gguf")) {
				// @ts-expect-error - path property might exist
				const path = file.path;
				if (path) {
					setLocalFile({
						name: file.name,
						path: path,
						size: file.size,
					});
				} else {
					// Fallback if hidden input is somehow used but no path
					alert(
						"Cannot resolve file path. Please use the main click area to browse.",
					);
				}
			} else {
				alert(
					t("settings.sections.models.add_modal.invalid_file"),
				);
			}
		}
		// Reset input value to allow re-selecting same file
		e.target.value = "";
	};

	const handleLocalSubmit = async () => {
		if (!localFile) return;

		try {
			// We now have the path in the state object
			const path = localFile.path;
			if (!path) {
				alert(
					t("settings.sections.models.add_modal.path_required"),
				);
				return;
			}

			await apiClient.post("api/setup/model/local", {
				file_path: path,
				role: selectedRole,
				display_name: localFile.name.replace(".gguf", ""),
			});
			onModelAdded();
			setLocalFile(null);
		} catch (e) {
			console.error(e);
		}
	};

	// Progress State
	const [progressData, setProgressData] = useState<{
		progress: number;
		message: string;
		current_bytes: number;
		total_bytes: number;
		speed_bps: number;
		eta_seconds: number;
	} | null>(null);

	// Initial listener for external progress (in case we rejoin a session or another tab triggered it)
	React.useEffect(() => {
		const handleProgress = (e: CustomEvent) => {
			const data = e.detail;
			setDownloading(true); // Ensure UI is in downloading mode
			setProgressData({
				progress: data.progress,
				message: data.message,
				current_bytes: data.current_bytes,
				total_bytes: data.total_bytes,
				speed_bps: data.speed_bps,
				eta_seconds: data.eta_seconds,
			});

			if (data.status === "completed" || data.status === "failed") {
				setDownloading(false);
				setProgressData(null);
				if (data.status === "completed") {
					onModelAdded();
					setRepoId("");
					setFilename("");
					setCheckStatus("idle");
				}
			}
		};

		window.addEventListener(
			"download-progress",
			handleProgress as EventListener,
		);
		return () => {
			window.removeEventListener(
				"download-progress",
				handleProgress as EventListener,
			);
		};
	}, [onModelAdded]);

	const handleDownload = async (acknowledgeWarnings = false) => {
		if (checkStatus !== "valid") return;

		setDownloading(true);
		setProgressData({
			progress: 0,
			message:
				t("settings.sections.models.add_modal.starting"),
			current_bytes: 0,
			total_bytes: 0,
			speed_bps: 0,
			eta_seconds: 0,
		});

		try {
			await apiClient.post("api/setup/model/download", {
				repo_id: repoId,
				filename: filename,
				role: selectedRole,
				acknowledge_warnings: acknowledgeWarnings,
			});

			// Note: success handling moved to event listener to support true async completion
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				const data = e.data as {
					requires_consent?: boolean;
					warnings?: Array<string | { warnings?: string[] }>;
				};
				if (data?.requires_consent && data.warnings) {
					const warnings: string[] = [];
					for (const warning of data.warnings) {
						if (typeof warning === "string") {
							warnings.push(warning);
						} else if (warning?.warnings && Array.isArray(warning.warnings)) {
							warnings.push(...warning.warnings);
						}
					}
					setConsentWarnings(
						warnings.length > 0
							? warnings
							: ["This download requires your confirmation."],
					);
					setShowConsentDialog(true);
					setDownloading(false);
					setProgressData(null);
					return;
				}
			}

			console.error(e);
			setDownloading(false);
			setProgressData(null);
		}
	};

	const handleConfirmDownload = () => {
		setShowConsentDialog(false);
		setConsentWarnings([]);
		handleDownload(true); // Retry with acknowledge_warnings = true
	};

	const handleCancelConsent = () => {
		setShowConsentDialog(false);
		setConsentWarnings([]);
	};

	// Helper to format bytes
	const formatBytes = (bytes: number) => {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB", "TB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
	};

	return (
		<div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden transition-all duration-300">
			<button
				type="button"
				onClick={() => setIsExpanded(!isExpanded)}
				className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors text-left"
			>
				<div className="flex items-center gap-2 font-medium text-gold-200">
					<Database size={18} />
					<span>
						{t("settings.sections.models.add_modal.title")}
					</span>
				</div>
				{isExpanded ? (
					<span className="text-xl rotate-45 transform transition-transform">
						+
					</span>
				) : (
					<span className="text-xl transition-transform">+</span>
				)}
			</button>

			{isExpanded && (
				<div className="p-4 border-t border-white/5 space-y-4">
					{/* Pool Selector */}
					<div className="flex gap-2 mb-4">
						{["text", "embedding"].map((r) => (
							<button
								type="button"
								key={r}
								onClick={() => setSelectedRole(r)}
								disabled={downloading}
								className={`px-3 py-1 text-xs rounded-full border transition-colors ${selectedRole === r
									? "bg-gold-500/20 border-gold-400 text-gold-100"
									: "border-white/10 text-gray-400 hover:border-white/20"
									} ${downloading ? "opacity-50 cursor-not-allowed" : ""}`}
							>
								{r === "text"
									? t("settings.sections.models.add_modal.role_text")
									: t("settings.sections.models.add_modal.role_embedding")}
							</button>
						))}
					</div>

					{/* Tabs */}
					<div className="flex border-b border-white/10 mb-4">
						<button
							type="button"
							disabled={downloading}
							className={`flex-1 pb-2 text-sm font-medium transition-colors ${mode === "hf" ? "text-white border-b-2 border-gold-400" : "text-gray-500 hover:text-gray-300"} ${downloading ? "opacity-50 cursor-not-allowed" : ""}`}
							onClick={() => setMode("hf")}
						>
							{t("settings.sections.models.add_modal.tab_huggingface")}
						</button>
						<button
							type="button"
							disabled={downloading}
							className={`flex-1 pb-2 text-sm font-medium transition-colors ${mode === "local" ? "text-white border-b-2 border-gold-400" : "text-gray-500 hover:text-gray-300"} ${downloading ? "opacity-50 cursor-not-allowed" : ""}`}
							onClick={() => setMode("local")}
						>
							{t("settings.sections.models.add_modal.tab_local")}
						</button>
					</div>

					{mode === "hf" ? (
						<div className="space-y-4">
							{!downloading ? (
								<>
									<div className="flex flex-col gap-4">
										<FormGroup
											label={
												t("settings.sections.models.add_modal.repo_id")
											}
										>
											<FormInput
												value={repoId}
												onChange={(v) => handleInput("repo", v as string)}
												placeholder={
													t(
														"settings.sections.models.add_modal.repo_id_placeholder",
													)
												}
												className="h-12 text-lg"
											/>
										</FormGroup>
										<FormGroup
											label={
												t("settings.sections.models.add_modal.filename")
											}
										>
											<div className="relative">
												<FormInput
													value={filename}
													onChange={(v) => handleInput("file", v as string)}
													placeholder={
														t(
															"settings.sections.models.add_modal.filename_placeholder",
														)
													}
													className="h-12 text-lg"
												/>
												<div className="absolute right-3 top-1/2 -translate-y-1/2">
													{checkStatus === "checking" && (
														<Loader2
															size={16}
															className="animate-spin text-gray-400"
														/>
													)}
													{checkStatus === "valid" && (
														<CheckCircle
															size={16}
															className="text-green-400 shadow-[0_0_10px_rgba(74,222,128,0.5)] animate-pulse"
														/>
													)}
													{checkStatus === "invalid" && (
														<XCircle size={16} className="text-red-400" />
													)}
												</div>
											</div>
										</FormGroup>
									</div>

									<button
										type="button"
										disabled={checkStatus !== "valid"}
										onClick={() => handleDownload()}
										className={`w-full py-2 rounded-lg flex items-center justify-center gap-2 font-medium transition-all ${checkStatus === "valid"
											? "bg-gold-500 hover:bg-gold-400 text-black shadow-lg shadow-gold-500/20"
											: "bg-white/5 text-gray-500 cursor-not-allowed"
											}`}
									>
										<Download size={18} />
										{t("settings.sections.models.add_modal.download")}
									</button>
								</>
							) : (
								<div className="space-y-3 bg-white/5 rounded-lg p-4 border border-white/10">
									<div className="flex justify-between text-xs text-gray-400">
										<span>
											{t("settings.sections.models.add_modal.downloading")}
										</span>
										<span>
											{progressData
												? Math.round(progressData.progress * 100)
												: 0}
											%
										</span>
									</div>

									<div className="h-2 bg-black/40 rounded-full overflow-hidden">
										<div
											className="h-full bg-gold-400 shadow-[0_0_10px_rgba(250,204,21,0.5)] transition-all duration-300 ease-out"
											style={{
												width: `${progressData ? progressData.progress * 100 : 0}%`,
											}}
										/>
									</div>

									<div className="flex justify-between items-end text-xs">
										<div className="text-gray-300">
											{progressData?.message || "Preparing..."}
										</div>
										<div className="text-right text-gray-500">
											{progressData && (
												<div>
													{formatBytes(progressData.current_bytes)} /{" "}
													{formatBytes(progressData.total_bytes)}
												</div>
											)}
										</div>
									</div>
								</div>
							)}
						</div>
					) : (
						// biome-ignore lint/a11y/useSemanticElements: Cannot use button due to nested interactive elements
						<div
							role="button"
							tabIndex={0}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") handleOpenDialog();
							}}
							className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${dragActive
								? "border-gold-400 bg-gold-400/5"
								: "border-white/10 hover:border-white/20 hover:bg-white/5"
								}`}
							onDragEnter={handleDrag}
							onDragLeave={handleDrag}
							onDragOver={handleDrag}
							onDrop={handleDrop}
							onClick={() => handleOpenDialog()}
						>
							<input
								ref={fileInputRef}
								type="file"
								accept=".gguf"
								onChange={handleFileSelect}
								className="hidden"
							/>
							{!localFile ? (
								<div className="space-y-2">
									<FileUp size={32} className="mx-auto text-gray-400" />
									<p className="text-gray-300 font-medium">
										{t("settings.sections.models.add_modal.drop_zone")}
									</p>
									<p className="text-gray-500 text-xs">
										{t("settings.sections.models.add_modal.drop_zone_hint")}
									</p>
								</div>
							) : (
								<div className="space-y-4">
									<div className="flex items-center justify-center gap-2 text-green-400 font-medium">
										<CheckCircle size={18} />
										<span>
											{localFile.name}{" "}
											{localFile.size &&
												`(${(localFile.size / 1024 / 1024).toFixed(1)} MB)`}
										</span>
									</div>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											handleLocalSubmit();
										}}
										className="px-6 py-2 bg-gold-500 text-black rounded-lg hover:bg-gold-400 transition-colors font-medium"
									>
										{t("settings.sections.models.add_modal.add_local")}
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setLocalFile(null);
										}}
										className="block mx-auto text-xs text-red-400 hover:text-red-300 mt-2"
									>
										{t("common.cancel")}
									</button>
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{/* Consent Warning Dialog */}
			{showConsentDialog && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
					<div className="bg-gray-900 border border-white/10 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
						<div className="flex items-center gap-3 mb-4">
							<div className="p-2 bg-amber-500/20 rounded-full">
								<AlertTriangle size={24} className="text-amber-400" />
							</div>
							<h3 className="text-lg font-semibold text-white">
								{t("settings.sections.models.consent_dialog.title")}
							</h3>
						</div>

						<p className="text-gray-300 text-sm mb-4">
							{t("settings.sections.models.consent_dialog.description")}
						</p>

						<div className="bg-black/30 rounded-lg p-3 mb-6 max-h-32 overflow-y-auto">
							<ul className="space-y-2">
								{consentWarnings.map((warning, idx) => (
									<li
										// biome-ignore lint/suspicious/noArrayIndexKey: Static list for display
										key={idx}
										className="text-amber-200 text-sm flex items-start gap-2"
									>
										<span className="text-amber-400 mt-0.5">•</span>
										<span>{warning}</span>
									</li>
								))}
							</ul>
						</div>

						<div className="flex gap-3">
							<button
								type="button"
								onClick={handleCancelConsent}
								className="flex-1 py-2 px-4 rounded-lg border border-white/10 text-gray-300 hover:bg-white/5 transition-colors"
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={handleConfirmDownload}
								className="flex-1 py-2 px-4 rounded-lg bg-gold-500 text-black font-medium hover:bg-gold-400 transition-colors"
							>
								{t("settings.sections.models.consent_dialog.confirm")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};
