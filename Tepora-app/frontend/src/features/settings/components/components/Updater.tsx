import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
	AlertCircle,
	CheckCircle,
	Download,
	RefreshCw,
	RotateCw,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CollapsibleSection } from "../SettingsComponents";

const Updater: React.FC = () => {
	const { t } = useTranslation();
	const [status, setStatus] = useState<
		| "idle"
		| "checking"
		| "available"
		| "uptodate"
		| "downloading"
		| "installing"
		| "relaunching"
		| "error"
	>("idle");
	const [currentVersion, setCurrentVersion] = useState<string>("");
	const [newVersion, setNewVersion] = useState<string>("");
	const [errorMsg, setErrorMsg] = useState<string>("");

	useEffect(() => {
		getVersion().then(setCurrentVersion);
	}, []);

	const checkForUpdates = async () => {
		setStatus("checking");
		setErrorMsg("");
		try {
			const update = await check();
			if (update?.available) {
				setNewVersion(update.version);
				setStatus("available");
			} else {
				setStatus("uptodate");
			}
		} catch (error) {
			console.error(error);
			setStatus("error");
			setErrorMsg(String(error));
		}
	};

	const installUpdate = async () => {
		setStatus("downloading");
		try {
			const update = await check();
			if (update?.available) {
				await update.downloadAndInstall((event) => {
					switch (event.event) {
						case "Started":
							// Future: event.data.contentLength for progress bar
							break;
						case "Progress":
							// Future: event.data.chunkLength for progress bar
							break;
						case "Finished":
							setStatus("installing");
							break;
					}
				});
				setStatus("relaunching");
				await relaunch();
			}
		} catch (error) {
			console.error(error);
			setStatus("error");
			setErrorMsg(String(error));
		}
	};

	return (
		<CollapsibleSection
			title={t("settings.sections.updater.title") || "Software Update"}
			description={
				t("settings.sections.updater.description") ||
				"Check for application updates"
			}
			defaultOpen={true}
		>
			<div className="flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<div className="text-sm text-gray-300">
						{t("settings.sections.updater.current_version") ||
							"Current Version"}
						: <span className="font-mono text-white">{currentVersion}</span>
					</div>
					{status === "available" && (
						<div className="text-sm text-green-400 font-medium">
							{t("settings.sections.updater.new_version") || "New Version"}:{" "}
							<span className="font-mono">{newVersion}</span>
						</div>
					)}
				</div>

				<div className="flex items-center gap-4">
					{status === "idle" || status === "uptodate" || status === "error" ? (
						<button
							type="button"
							onClick={checkForUpdates}
							className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-md transition-colors text-sm font-medium text-white"
						>
							<RefreshCw size={16} />
							{t("settings.sections.updater.check_button") ||
								"Check for Updates"}
						</button>
					) : status === "available" ? (
						<button
							type="button"
							onClick={installUpdate}
							className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-md transition-colors text-sm font-medium text-white"
						>
							<Download size={16} />
							{t("settings.sections.updater.update_button") || "Update Now"}
						</button>
					) : (
						<div className="flex items-center gap-2 px-4 py-2 bg-white/5 rounded-md text-sm text-gray-300 cursor-not-allowed">
							<RotateCw size={16} className="animate-spin" />
							{status === "checking" &&
								(t("settings.sections.updater.checking") || "Checking...")}
							{status === "downloading" &&
								(t("settings.sections.updater.downloading") ||
									"Downloading...")}
							{status === "installing" &&
								(t("settings.sections.updater.installing") || "Installing...")}
							{status === "relaunching" &&
								(t("settings.sections.updater.relaunching") ||
									"Relaunching...")}
						</div>
					)}
				</div>

				{status === "uptodate" && (
					<div className="flex items-center gap-2 text-sm text-green-400">
						<CheckCircle size={16} />
						{t("settings.sections.updater.uptodate") || "You are up to date!"}
					</div>
				)}

				{status === "error" && (
					<div className="flex items-center gap-2 text-sm text-red-400">
						<AlertCircle size={16} />
						{t("settings.sections.updater.error") ||
							"Error checking for updates"}
						: {errorMsg}
					</div>
				)}
			</div>
		</CollapsibleSection>
	);
};

export default Updater;
