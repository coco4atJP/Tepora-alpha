import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../shared/ui/Button";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { Select } from "../../../../shared/ui/Select";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import {
	readNestedValue,
	useSettingsEditor,
} from "../../model/editor";
import {
	useAgentSkillQuery,
	useAgentSkillsQuery,
	useDeleteAgentSkillMutation,
	useSaveAgentSkillMutation,
} from "../../model/queries";
import type {
	AgentSkillPackage,
	SkillFileEntry,
	SkillRootConfig,
} from "../../../../shared/contracts";

function emptyFile(kind: string): SkillFileEntry {
	return {
		path: "",
		kind,
		content: "",
		encoding: "utf8",
	};
}

function createTemplate(rootPath?: string): AgentSkillPackage {
	return {
		id: "new-skill",
		name: "new-skill",
		description: "Describe when this skill should be selected.",
		package_dir: "",
		root_path: rootPath ?? "",
		root_label: undefined,
		metadata: {},
		display_name: undefined,
		short_description: undefined,
		valid: true,
		writable: true,
		warnings: [],
		skill_markdown:
			"---\nname: new-skill\ndescription: Describe when this skill should be selected.\n---\n\n# New Skill\n\nDescribe the execution workflow here.\n",
		skill_body: "",
		openai_yaml: "",
		references: [],
		scripts: [],
		assets: [],
		other_files: [],
	};
}

function SkillFileListEditor({
	title,
	kind,
	files,
	onChange,
}: {
	title: string;
	kind: string;
	files: SkillFileEntry[];
	onChange: (nextFiles: SkillFileEntry[]) => void;
}) {
	return (
		<div className="rounded-[22px] border border-primary/10 bg-surface/45 p-4">
			<div className="flex items-center justify-between gap-3">
				<div className="text-sm font-medium text-text-main">{title}</div>
				<Button
					type="button"
					variant="ghost"
					onClick={() => onChange([...files, emptyFile(kind)])}
				>
					Add File
				</Button>
			</div>
			<div className="mt-4 space-y-4">
				{files.length === 0 ? (
					<div className="text-sm text-text-muted">No files configured.</div>
				) : null}
				{files.map((file, index) => (
					<div
						key={`${title}-${index}`}
						className="rounded-[18px] border border-primary/10 bg-white/55 p-4"
					>
						<div className="flex items-center gap-3">
							<div className="flex-1">
								<TextField
									value={file.path}
									onChange={(event) =>
										onChange(
											files.map((entry, entryIndex) =>
												entryIndex === index
													? { ...entry, path: event.target.value }
													: entry,
											),
										)
									}
									placeholder={`${kind}/file.md`}
								/>
							</div>
							<Button
								type="button"
								variant="ghost"
								onClick={() =>
									onChange(
										files.filter((_, entryIndex) => entryIndex !== index),
									)
								}
							>
								Remove
							</Button>
						</div>
						<div className="mt-3">
							<textarea
								value={file.content}
								onChange={(event) =>
									onChange(
										files.map((entry, entryIndex) =>
											entryIndex === index
												? { ...entry, content: event.target.value }
												: entry,
										),
									)
								}
								className="min-h-[140px] w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
								spellCheck={false}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function AgentSkillsManagementPanel() {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const skillsQuery = useAgentSkillsQuery();
	const saveSkill = useSaveAgentSkillMutation();
	const deleteSkill = useDeleteAgentSkillMutation();
	const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
	const [editingSkill, setEditingSkill] = useState<AgentSkillPackage | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const detailQuery = useAgentSkillQuery(selectedSkillId);

	const rootsValue = editor.draft
		? readNestedValue(editor.draft, "agent_skills.roots")
		: undefined;
	const configuredRoots = Array.isArray(rootsValue)
		? (rootsValue.filter(
				(root): root is SkillRootConfig =>
					Boolean(root) && typeof root === "object" && "path" in root,
		  ) as SkillRootConfig[])
		: [];

	const skills = useMemo(() => {
		return [...(skillsQuery.data?.skills ?? [])].sort((left, right) =>
			left.name.localeCompare(right.name),
		);
	}, [skillsQuery.data?.skills]);

	useEffect(() => {
		if (!selectedSkillId && !editingSkill && skills.length > 0) {
			setSelectedSkillId(skills[0]?.id ?? null);
		}
	}, [editingSkill, selectedSkillId, skills]);

	useEffect(() => {
		if (selectedSkillId && detailQuery.data) {
			setEditingSkill(detailQuery.data);
		}
	}, [detailQuery.data, selectedSkillId]);

	const writableRoots = skillsQuery.data?.roots.filter((root) => root.writable) ?? [];

	const updateRoots = (nextRoots: SkillRootConfig[]) => {
		editor.updateField("agent_skills.roots", nextRoots);
	};

	const saveCurrentSkill = async () => {
		if (!editingSkill) {
			return;
		}

		try {
			setActionError(null);
			const response = await saveSkill.mutateAsync({
				id: editingSkill.id,
				root_path: editingSkill.root_path || undefined,
				skill_markdown: editingSkill.skill_markdown,
				openai_yaml: editingSkill.openai_yaml || undefined,
				references: editingSkill.references,
				scripts: editingSkill.scripts,
				assets: editingSkill.assets,
				other_files: editingSkill.other_files,
			});
			setSelectedSkillId(response.skill.id);
			setEditingSkill(response.skill);
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : "Failed to save Agent Skill.",
			);
		}
	};

	const deleteCurrentSkill = async () => {
		if (!editingSkill?.id) {
			return;
		}
		if (!window.confirm(`Delete Agent Skill '${editingSkill.id}'?`)) {
			return;
		}

		try {
			setActionError(null);
			await deleteSkill.mutateAsync(editingSkill.id);
			setSelectedSkillId(null);
			setEditingSkill(null);
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : "Failed to delete Agent Skill.",
			);
		}
	};

	return (
		<div className="flex flex-col gap-8">
			<SettingsSectionGroup title={t("v2.settings.agentSkills", "Agent Skills")}>
				<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
					{t(
						"v2.settings.agentSkillsHint",
						"Root changes are stored in settings. Save settings to apply new roots before creating packages inside them.",
					)}
				</div>
				<div className="grid gap-4">
					{configuredRoots.map((root, index) => (
						<div
							key={`${root.path}-${index}`}
							className="grid gap-3 rounded-[22px] border border-primary/10 bg-surface/45 p-4 lg:grid-cols-[1.5fr_1fr_auto_auto]"
						>
							<TextField
								value={root.path}
								onChange={(event) =>
									updateRoots(
										configuredRoots.map((entry, entryIndex) =>
											entryIndex === index
												? { ...entry, path: event.target.value }
												: entry,
										),
									)
								}
								placeholder="/path/to/skills"
							/>
							<TextField
								value={root.label ?? ""}
								onChange={(event) =>
									updateRoots(
										configuredRoots.map((entry, entryIndex) =>
											entryIndex === index
												? { ...entry, label: event.target.value }
												: entry,
										),
									)
								}
								placeholder="Optional label"
							/>
							<div className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
								<span className="text-sm text-text-main">Enabled</span>
								<MinToggle
									checked={root.enabled !== false}
									onChange={(checked) =>
										updateRoots(
											configuredRoots.map((entry, entryIndex) =>
												entryIndex === index
													? { ...entry, enabled: checked }
													: entry,
											),
										)
									}
									label={root.enabled !== false ? "On" : "Off"}
								/>
							</div>
							<Button
								type="button"
								variant="ghost"
								onClick={() =>
									updateRoots(
										configuredRoots.filter((_, entryIndex) => entryIndex !== index),
									)
								}
							>
								Remove
							</Button>
						</div>
					))}
					<Button
						type="button"
						variant="ghost"
						onClick={() =>
							updateRoots([
								...configuredRoots,
								{ path: "", enabled: true, label: "" },
							])
						}
					>
						Add Root
					</Button>
				</div>
			</SettingsSectionGroup>

			<SettingsSectionGroup title={t("v2.settings.skillPackages", "Skill Packages")}>
				{actionError ? (
					<div className="rounded-[24px] border border-red-500/20 bg-red-500/10 px-6 py-5 text-sm text-red-200">
						{actionError}
					</div>
				) : null}
				<div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
					<div className="space-y-4">
						<div className="flex gap-2">
							<Button
								type="button"
								onClick={() => {
									setActionError(null);
									setSelectedSkillId(null);
									setEditingSkill(createTemplate(writableRoots[0]?.path));
								}}
							>
								New Skill
							</Button>
							<Button
								type="button"
								variant="ghost"
								onClick={() => void skillsQuery.refetch()}
							>
								Refresh
							</Button>
						</div>
						<div className="space-y-3">
							{skills.length === 0 ? (
								<div className="rounded-[22px] border border-primary/10 bg-white/55 px-5 py-4 text-sm text-text-muted">
									No Agent Skills found.
								</div>
							) : null}
							{skills.map((skill) => {
								const selected = selectedSkillId === skill.id;
								return (
									<button
										type="button"
										key={skill.id}
										onClick={() => setSelectedSkillId(skill.id)}
										className={`w-full rounded-[22px] border p-4 text-left transition-colors ${
											selected
												? "border-primary/20 bg-primary/8"
												: "border-primary/10 bg-white/55 hover:bg-white/70"
										}`}
									>
										<div className="text-sm font-medium text-text-main">
											{skill.display_name || skill.name}
										</div>
										<div className="mt-1 text-xs uppercase tracking-[0.16em] text-text-muted">
											{skill.id}
										</div>
										<div className="mt-3 text-sm leading-6 text-text-muted">
											{skill.short_description || skill.description}
										</div>
									</button>
								);
							})}
						</div>
					</div>

					<div className="space-y-4">
						{editingSkill ? (
							<>
								<div className="grid gap-4 rounded-[24px] border border-primary/10 bg-white/55 p-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
									<div>
										<div className="text-xs uppercase tracking-[0.16em] text-text-muted">
											Skill ID
										</div>
										<div className="mt-2">
											<TextField
												value={editingSkill.id}
												onChange={(event) =>
													setEditingSkill({
														...editingSkill,
														id: event.target.value,
													})
												}
												placeholder="new-skill"
											/>
										</div>
									</div>
									<div>
										<div className="text-xs uppercase tracking-[0.16em] text-text-muted">
											Writable Root
										</div>
										<div className="mt-2">
											<Select
												value={editingSkill.root_path}
												onChange={(event) =>
													setEditingSkill({
														...editingSkill,
														root_path: event.target.value,
													})
												}
											>
												<option value="">Select root</option>
												{writableRoots.map((root) => (
													<option key={root.path} value={root.path}>
														{root.label
															? `${root.label} (${root.path})`
															: root.path}
													</option>
												))}
											</Select>
										</div>
									</div>
									<div className="lg:col-span-2 flex flex-wrap gap-2">
										<Button
											type="button"
											onClick={() => void saveCurrentSkill()}
											disabled={saveSkill.isPending}
										>
											{saveSkill.isPending ? "Saving..." : "Save Skill"}
										</Button>
										<Button
											type="button"
											variant="ghost"
											onClick={() => {
												setActionError(null);
												setSelectedSkillId(null);
												setEditingSkill(createTemplate(writableRoots[0]?.path));
											}}
										>
											Reset Draft
										</Button>
										<Button
											type="button"
											variant="ghost"
											onClick={() => void deleteCurrentSkill()}
											disabled={!selectedSkillId || deleteSkill.isPending}
										>
											{deleteSkill.isPending ? "Deleting..." : "Delete"}
										</Button>
									</div>
								</div>

								<div className="rounded-[24px] border border-primary/10 bg-white/55 p-5">
									<div className="text-sm font-medium text-text-main">SKILL.md</div>
									<div className="mt-3">
										<textarea
											value={editingSkill.skill_markdown}
											onChange={(event) =>
												setEditingSkill({
													...editingSkill,
													skill_markdown: event.target.value,
												})
											}
											className="min-h-[260px] w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
											spellCheck={false}
										/>
									</div>
								</div>

								<div className="rounded-[24px] border border-primary/10 bg-white/55 p-5">
									<div className="text-sm font-medium text-text-main">
										agents/openai.yaml
									</div>
									<div className="mt-3">
										<textarea
											value={editingSkill.openai_yaml ?? ""}
											onChange={(event) =>
												setEditingSkill({
													...editingSkill,
													openai_yaml: event.target.value,
												})
											}
											className="min-h-[180px] w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
											spellCheck={false}
											placeholder="Optional OpenAI orchestration yaml"
										/>
									</div>
								</div>

								<SkillFileListEditor
									title="References"
									kind="reference"
									files={editingSkill.references}
									onChange={(nextFiles) =>
										setEditingSkill({ ...editingSkill, references: nextFiles })
									}
								/>
								<SkillFileListEditor
									title="Scripts"
									kind="script"
									files={editingSkill.scripts}
									onChange={(nextFiles) =>
										setEditingSkill({ ...editingSkill, scripts: nextFiles })
									}
								/>
								<SkillFileListEditor
									title="Assets"
									kind="asset"
									files={editingSkill.assets}
									onChange={(nextFiles) =>
										setEditingSkill({ ...editingSkill, assets: nextFiles })
									}
								/>
								<SkillFileListEditor
									title="Other Files"
									kind="other"
									files={editingSkill.other_files}
									onChange={(nextFiles) =>
										setEditingSkill({ ...editingSkill, other_files: nextFiles })
									}
								/>
							</>
						) : (
							<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm text-text-muted">
								Select an existing skill or create a new one.
							</div>
						)}
					</div>
				</div>
			</SettingsSectionGroup>
		</div>
	);
}
