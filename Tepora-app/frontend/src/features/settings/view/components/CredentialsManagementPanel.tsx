import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../shared/ui/Button";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";
import {
	useCredentialStatusesQuery,
	useRotateCredentialMutation,
} from "../../model/queries";

const PROVIDERS = [
	{
		id: "google_search",
		label: "Google Search",
		secretPath: "tools.google_search_api_key",
		auxiliaryFields: [
			{
				path: "tools.google_search_engine_id",
				label: "Search Engine ID",
				placeholder: "Custom Search Engine ID",
			},
		],
	},
	{
		id: "brave_search",
		label: "Brave Search",
		secretPath: "tools.brave_search_api_key",
		auxiliaryFields: [],
	},
	{
		id: "bing_search",
		label: "Bing Search",
		secretPath: "tools.bing_search_api_key",
		auxiliaryFields: [],
	},
] as const;

const STATUS_TONE: Record<string, string> = {
	active: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
	expiring_soon: "border-amber-500/20 bg-amber-500/10 text-amber-200",
	expired: "border-red-500/20 bg-red-500/10 text-red-200",
	missing: "border-primary/10 bg-primary/5 text-text-muted",
};

function formatTimestamp(value?: string | null) {
	if (!value) {
		return "-";
	}

	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function CredentialsManagementPanel() {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const statusesQuery = useCredentialStatusesQuery();
	const rotateCredential = useRotateCredentialMutation();
	const [expiryDrafts, setExpiryDrafts] = useState<Record<string, string>>({});
	const [actionError, setActionError] = useState<string | null>(null);

	useEffect(() => {
		if (!statusesQuery.data) {
			return;
		}

		setExpiryDrafts((current) => {
			const next = { ...current };
			for (const status of statusesQuery.data.credentials) {
				if (!(status.provider in next)) {
					next[status.provider] = status.expires_at ?? "";
				}
			}
			return next;
		});
	}, [statusesQuery.data]);

	const statuses = useMemo(() => {
		return new Map(
			(statusesQuery.data?.credentials ?? []).map((status) => [status.provider, status]),
		);
	}, [statusesQuery.data]);

	return (
		<SettingsSectionGroup title={t("v2.settings.credentials", "Credentials")}>
			{actionError ? (
				<div className="rounded-[24px] border border-red-500/20 bg-red-500/10 px-6 py-5 text-sm text-red-200">
					{actionError}
				</div>
			) : null}
			<div className="grid gap-4 xl:grid-cols-2">
				{PROVIDERS.map((provider) => {
					const status = statuses.get(provider.id);
					const statusLabel = status?.status ?? (status?.present ? "active" : "missing");
					const toneClass = STATUS_TONE[statusLabel] ?? STATUS_TONE.missing;
					const secret = editor.readString(provider.secretPath, "");

					return (
						<div
							key={provider.id}
							className="rounded-[24px] border border-primary/10 bg-white/55 p-5"
						>
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="text-base font-medium text-text-main">
										{provider.label}
									</div>
									<div className="mt-1 text-sm text-text-muted">
										{t(
											"v2.settings.credentialStatusDescription",
											"Track presence, expiry, and last rotation while keeping the underlying value in sync with settings.",
										)}
									</div>
								</div>
								<div
									className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.16em] ${toneClass}`}
								>
									{statusLabel.replaceAll("_", " ")}
								</div>
							</div>

							<div className="mt-5 flex flex-col gap-5">
								<SettingsRow
									label={t("v2.settings.apiKey", "API Key")}
									description={t(
										"v2.settings.apiKeyDescription",
										"Saved through the backend config/secret flow.",
									)}
								>
									<div className="w-full min-w-[18rem] flex-1">
										<TextField
											type="password"
											value={secret}
											onChange={(event) =>
												editor.updateField(
													provider.secretPath,
													event.target.value,
												)
											}
											placeholder={`${provider.label} API key`}
										/>
									</div>
								</SettingsRow>

								{provider.auxiliaryFields.map((field) => (
									<SettingsRow key={field.path} label={field.label}>
										<div className="w-full min-w-[18rem] flex-1">
											<TextField
												value={editor.readString(field.path, "")}
												onChange={(event) =>
													editor.updateField(field.path, event.target.value)
												}
												placeholder={field.placeholder}
											/>
										</div>
									</SettingsRow>
								))}

								<SettingsRow
									label={t("v2.settings.expiry", "Expiry")}
									description={t(
										"v2.settings.expiryDescription",
										"Optional ISO timestamp sent when rotating the credential.",
									)}
								>
									<div className="w-full min-w-[18rem] flex-1">
										<TextField
											value={expiryDrafts[provider.id] ?? ""}
											onChange={(event) =>
												setExpiryDrafts((current) => ({
													...current,
													[provider.id]: event.target.value,
												}))
											}
											placeholder="2026-12-31T23:59:59Z"
										/>
									</div>
								</SettingsRow>

								<div className="grid gap-3 rounded-[20px] border border-primary/10 bg-surface/50 p-4 sm:grid-cols-2">
									<div>
										<div className="text-[0.72rem] uppercase tracking-[0.16em] text-text-muted">
											{t("v2.settings.present", "Present")}
										</div>
										<div className="mt-1 text-sm text-text-main">
											{status?.present ? "Yes" : "No"}
										</div>
									</div>
									<div>
										<div className="text-[0.72rem] uppercase tracking-[0.16em] text-text-muted">
											{t("v2.settings.lastRotated", "Last Rotated")}
										</div>
										<div className="mt-1 text-sm text-text-main">
											{formatTimestamp(status?.last_rotated_at)}
										</div>
									</div>
									<div>
										<div className="text-[0.72rem] uppercase tracking-[0.16em] text-text-muted">
											{t("v2.settings.currentExpiry", "Current Expiry")}
										</div>
										<div className="mt-1 text-sm text-text-main">
											{formatTimestamp(status?.expires_at)}
										</div>
									</div>
									<div className="flex items-end justify-start sm:justify-end">
										<Button
											type="button"
											onClick={async () => {
												try {
													setActionError(null);
													await rotateCredential.mutateAsync({
													provider: provider.id,
													secret,
													expires_at:
														expiryDrafts[provider.id]?.trim() || undefined,
													});
												} catch (error) {
													setActionError(
														error instanceof Error
															? error.message
															: "Failed to rotate credential.",
													);
												}
											}}
											disabled={!secret.trim() || rotateCredential.isPending}
										>
											{rotateCredential.isPending
												? t("v2.settings.rotating", "Rotating...")
												: t("v2.settings.rotateNow", "Rotate Now")}
										</Button>
									</div>
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</SettingsSectionGroup>
	);
}
