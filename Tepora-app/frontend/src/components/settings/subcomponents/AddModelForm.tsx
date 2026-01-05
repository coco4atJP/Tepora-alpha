import {
	CheckCircle,
	Database,
	Download,
	FileUp,
	Loader2,
	XCircle,
} from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { getApiBase, getAuthHeaders } from "../../../utils/api";
import { FormGroup, FormInput } from "../SettingsComponents";

interface AddModelFormProps {
	onModelAdded: () => void;
}

export const AddModelForm: React.FC<AddModelFormProps> = ({ onModelAdded }) => {
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
	const [localFile, setLocalFile] = useState<File | null>(null);

	const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleCheck = useCallback(async (r: string, f: string) => {
		if (!r || !f) {
			setCheckStatus("idle");
			return;
		}

		setCheckStatus("checking");
		try {
			const res = await fetch(`${getApiBase()}/api/setup/model/check`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...getAuthHeaders(),
				},
				body: JSON.stringify({ repo_id: r, filename: f }),
			});
			const data = await res.json();
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
				setLocalFile(file);
			} else {
				alert("Only .gguf files are supported");
			}
		}
	};

	const handleLocalSubmit = async () => {
		if (!localFile) return;

		try {
			// @ts-expect-error - Electron adds path property to File objects
			const path = localFile.path;
			if (!path) {
				alert(
					"Cannot resolve file path. This feature requires a desktop environment.",
				);
				return;
			}

			const res = await fetch(`${getApiBase()}/api/setup/model/local`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...getAuthHeaders() },
				body: JSON.stringify({
					file_path: path,
					role: selectedRole,
					display_name: localFile.name.replace(".gguf", ""),
				}),
			});

			if (res.ok) {
				onModelAdded();
				setLocalFile(null);
			}
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
	// For now we assume local trigger, but this helps decoupling.
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

	const handleDownload = async () => {
		if (checkStatus !== "valid") return;

		setDownloading(true);
		setProgressData({
			progress: 0,
			message: "Starting download...",
			current_bytes: 0,
			total_bytes: 0,
			speed_bps: 0,
			eta_seconds: 0,
		});

		try {
			await fetch(`${getApiBase()}/api/setup/model/download`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...getAuthHeaders() },
				body: JSON.stringify({
					repo_id: repoId,
					filename: filename,
					role: selectedRole,
				}),
			});

			// Note: success handling moved to event listener to support true async completion
		} catch (e) {
			console.error(e);
			setDownloading(false);
			setProgressData(null);
		}
	};

	// Helper to format bytes
	const formatBytes = (bytes: number) => {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB", "TB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
	};

	// ... (rest of the component)

	return (
		<div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden transition-all duration-300">
			{/* ... (header) ... */}
			<button
				onClick={() => setIsExpanded(!isExpanded)}
				className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors text-left"
			>
				<div className="flex items-center gap-2 font-medium text-gold-200">
					<Database size={18} />
					<span>モデルを追加</span>
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
					{/* ... (selectors) ... */}
					{/* Pool Selector */}
					<div className="flex gap-2 mb-4">
						{["text", "embedding"].map((r) => (
							<button
								key={r}
								onClick={() => setSelectedRole(r)}
								disabled={downloading}
								className={`px-3 py-1 text-xs rounded-full border transition-colors ${
									selectedRole === r
										? "bg-gold-500/20 border-gold-400 text-gold-100"
										: "border-white/10 text-gray-400 hover:border-white/20"
								} ${downloading ? "opacity-50 cursor-not-allowed" : ""}`}
							>
								{r === "text" ? "Text Model" : "Embedding Model"}
							</button>
						))}
					</div>

					{/* Tabs */}
					<div className="flex border-b border-white/10 mb-4">
						<button
							disabled={downloading}
							className={`flex-1 pb-2 text-sm font-medium transition-colors ${mode === "hf" ? "text-white border-b-2 border-gold-400" : "text-gray-500 hover:text-gray-300"} ${downloading ? "opacity-50 cursor-not-allowed" : ""}`}
							onClick={() => setMode("hf")}
						>
							Hugging Face
						</button>
						<button
							disabled={downloading}
							className={`flex-1 pb-2 text-sm font-medium transition-colors ${mode === "local" ? "text-white border-b-2 border-gold-400" : "text-gray-500 hover:text-gray-300"} ${downloading ? "opacity-50 cursor-not-allowed" : ""}`}
							onClick={() => setMode("local")}
						>
							Local File
						</button>
					</div>

					{mode === "hf" ? (
						<div className="space-y-4">
							{!downloading ? (
								<>
									<div className="grid grid-cols-[2fr_3fr] gap-2">
										<FormGroup label="Repo ID">
											<FormInput
												value={repoId}
												onChange={(v) => handleInput("repo", v as string)}
												placeholder="user/repo"
											/>
										</FormGroup>
										<FormGroup label="Filename">
											<div className="relative">
												<FormInput
													value={filename}
													onChange={(v) => handleInput("file", v as string)}
													placeholder="model-Q4_K_M.gguf"
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
										disabled={checkStatus !== "valid"}
										onClick={handleDownload}
										className={`w-full py-2 rounded-lg flex items-center justify-center gap-2 font-medium transition-all ${
											checkStatus === "valid"
												? "bg-gold-500 hover:bg-gold-400 text-black shadow-lg shadow-gold-500/20"
												: "bg-white/5 text-gray-500 cursor-not-allowed"
										}`}
									>
										<Download size={18} />
										Download Model
									</button>
								</>
							) : (
								<div className="space-y-3 bg-white/5 rounded-lg p-4 border border-white/10">
									<div className="flex justify-between text-xs text-gray-400">
										<span>Downloading...</span>
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
												<>
													<div>
														{formatBytes(progressData.current_bytes)} /{" "}
														{formatBytes(progressData.total_bytes)}
													</div>
													{/* <div>{formatBytes(progressData.speed_bps)}/s</div> */}
												</>
											)}
										</div>
									</div>
								</div>
							)}
						</div>
					) : (
						<div
							className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
								dragActive
									? "border-gold-400 bg-gold-400/5"
									: "border-white/10 hover:border-white/20 hover:bg-white/5"
							}`}
							onDragEnter={handleDrag}
							onDragLeave={handleDrag}
							onDragOver={handleDrag}
							onDrop={handleDrop}
						>
							{!localFile ? (
								<div className="space-y-2 pointer-events-none">
									<FileUp size={32} className="mx-auto text-gray-400" />
									<p className="text-gray-300 font-medium">
										Drag & Drop .gguf file here
									</p>
									<p className="text-gray-500 text-xs">
										or use the file picker (not implemented in this demo)
									</p>
								</div>
							) : (
								<div className="space-y-4">
									<div className="flex items-center justify-center gap-2 text-green-400 font-medium">
										<CheckCircle size={18} />
										<span>
											{localFile.name} (
											{(localFile.size / 1024 / 1024).toFixed(1)} MB)
										</span>
									</div>
									<button
										onClick={handleLocalSubmit}
										className="px-6 py-2 bg-gold-500 text-black rounded-lg hover:bg-gold-400 transition-colors font-medium"
									>
										Register Model
									</button>
									<button
										onClick={() => setLocalFile(null)}
										className="block mx-auto text-xs text-red-400 hover:text-red-300 mt-2"
									>
										Cancel
									</button>
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
};
