import type { SetupModel } from "../../../shared/contracts";

export type ModelRoleFilter = "all" | "text" | "embedding";

export interface ActiveJobState {
	jobId: string;
	type: "download" | "binary";
}

export interface DownloadPayload {
	repo_id: string;
	filename: string;
	role: string;
	display_name: string;
	revision?: string;
	sha256?: string;
	acknowledge_warnings?: boolean;
}

export interface ConsentRequestState {
	payload: DownloadPayload;
	warnings: string[];
}

export type DeleteTarget = SetupModel | null;
