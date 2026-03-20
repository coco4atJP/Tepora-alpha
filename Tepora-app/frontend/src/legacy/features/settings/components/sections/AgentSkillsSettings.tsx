import { Bot, FolderTree, PackagePlus, RefreshCw, Save, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../components/ui/Button";
import {
	useAgentSkills,
	useSettingsConfigActions,
	useSettingsState,
} from "../../../../context/SettingsContext";
import type { AgentSkillPackage, AgentSkillSummary, SkillFileEntry, SkillRootConfig } from "../../../../types";
import { FormGroup, FormInput, FormSwitch, SettingsSection } from "../SettingsComponents";

interface AgentSkillsSettingsProps {
	agents: Record<string, AgentSkillSummary>;
}

const emptyFile = (kind: string): SkillFileEntry => ({
	path: "",
	kind,
	content: "",
	encoding: "utf8",
});

const createTemplate = (id: string, rootPath?: string): AgentSkillPackage => ({
	id,
	name: id || "new-skill",
	description: "Describe when this skill should be selected.",
	package_dir: "",
	root_path: rootPath || "",
	root_label: undefined,
	metadata: {},
	display_name: undefined,
	short_description: undefined,
	valid: true,
	writable: true,
	warnings: [],
	skill_markdown: `---\nname: ${id || "new-skill"}\ndescription: Describe when this skill should be selected.\n---\n\n# ${id || "New Skill"}\n\nDescribe the execution workflow here.\n`,
	skill_body: "",
	openai_yaml: "",
	references: [],
	scripts: [],
	assets: [],
	other_files: [],
});

const SkillFileListEditor: React.FC<{
	title: string;
	files: SkillFileEntry[];
	onChange: (files: SkillFileEntry[]) => void;
}> = ({ title, files, onChange }) => {
	const { t } = useTranslation();
	return (
		<div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
			<div className="flex items-center justify-between gap-3">
				<div className="text-sm font-semibold text-white">{title}</div>
				<Button size="sm" variant="ghost" onClick={() => onChange([...files, emptyFile(title.toLowerCase())])}>
					{t("settings.sections.execution_agents.add_file", "Add File")}
				</Button>
			</div>
			{files.length === 0 ? (
				<div className="text-xs text-gray-500">{t("settings.sections.execution_agents.no_files", "No files.")}</div>
			) : (
				<div className="space-y-4">
					{files.map((file, index) => (
						<div key={`${title}-${index}`} className="space-y-2 rounded-xl border border-white/5 bg-black/20 p-3">
							<div className="flex items-center gap-2">
								<FormInput
									value={file.path}
									onChange={(value) =>
										onChange(
											files.map((item, itemIndex) =>
												itemIndex === index ? { ...item, path: value as string } : item,
											),
										)
									}
									placeholder={`${title.toLowerCase()}/file.md`}
								/>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}
								>
									<Trash2 size={14} />
								</Button>
							</div>
							<textarea
								value={file.content}
								onChange={(event) =>
									onChange(
										files.map((item, itemIndex) =>
											itemIndex === index ? { ...item, content: event.target.value } : item,
										),
									)
								}
								className="min-h-[120px] w-full rounded-xl border border-white/10 bg-[#0B0E13] p-3 text-sm text-gray-200 outline-none focus:border-gold-400/40"
								spellCheck={false}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

const AgentSkillsSettings: React.FC<AgentSkillsSettingsProps> = ({ agents }) => {
	const { t } = useTranslation();
	const { config } = useSettingsState();
	const {
		skillRoots,
		fetchAgentSkills,
		getAgentSkill,
		saveAgentSkill,
		deleteAgentSkill,
	} = useAgentSkills();
	const { updateConfigPath } = useSettingsConfigActions();
	const entries = useMemo(
		() => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)),
		[agents],
	);
	const [selectedSkillId, setSelectedSkillId] = useState("");
	const [editingSkill, setEditingSkill] = useState<AgentSkillPackage | null>(null);
	const [isLoadingSkill, setIsLoadingSkill] = useState(false);
	const [isSavingSkill, setIsSavingSkill] = useState(false);
	const [isDeletingSkill, setIsDeletingSkill] = useState(false);
	const [newSkillId, setNewSkillId] = useState("new-skill");

	useEffect(() => {
		if (!selectedSkillId && entries.length > 0) {
			setSelectedSkillId(entries[0]?.id || "");
		}
	}, [entries, selectedSkillId]);

	useEffect(() => {
		if (!selectedSkillId) {
			setEditingSkill(null);
			return;
		}

		let active = true;
		setIsLoadingSkill(true);
		void getAgentSkill(selectedSkillId)
			.then((skill) => {
				if (active) {
					setEditingSkill(skill);
				}
			})
			.catch((error) => {
				console.error("Failed to load Agent Skill", error);
			})
			.finally(() => {
				if (active) {
					setIsLoadingSkill(false);
				}
			});
		return () => {
			active = false;
		};
	}, [getAgentSkill, selectedSkillId]);

	const configuredRoots = (config?.agent_skills?.roots || []).map((root) => ({
		path: root.path || "",
		enabled: root.enabled ?? true,
		label: root.label || "",
	}));

	const updateRoots = (nextRoots: SkillRootConfig[]) => {
		updateConfigPath("agent_skills.roots", nextRoots);
	};

	const createNewSkill = () => {
		const fallbackRoot = skillRoots.find((root) => root.writable)?.path || "";
		const skill = createTemplate(newSkillId.trim() || "new-skill", fallbackRoot);
		setSelectedSkillId("");
		setEditingSkill(skill);
	};

	const handleSaveSkill = async () => {
		if (!editingSkill) return;
		setIsSavingSkill(true);
		try {
			const saved = await saveAgentSkill({
				id: editingSkill.id,
				root_path: editingSkill.root_path,
				skill_markdown: editingSkill.skill_markdown,
				openai_yaml: editingSkill.openai_yaml || undefined,
				references: editingSkill.references,
				scripts: editingSkill.scripts,
				assets: editingSkill.assets,
				other_files: editingSkill.other_files,
			});
			setSelectedSkillId(saved.id);
			setEditingSkill(saved);
		} catch (error) {
			console.error("Failed to save Agent Skill", error);
		} finally {
			setIsSavingSkill(false);
		}
	};

	const handleDeleteSkill = async () => {
		if (!editingSkill?.id || !window.confirm(`Delete Agent Skill '${editingSkill.id}'?`)) return;
		setIsDeletingSkill(true);
		try {
			await deleteAgentSkill(editingSkill.id);
			setSelectedSkillId("");
			setEditingSkill(null);
		} catch (error) {
			console.error("Failed to delete Agent Skill", error);
		} finally {
			setIsDeletingSkill(false);
		}
	};

	return (
		<SettingsSection
			title={t("settings.sections.execution_agents.title", "Agent Skills")}
			icon={<Bot size={18} />}
			description={t(
				"settings.sections.execution_agents.description",
				"Supervisor reads each skill's metadata, while Execution follows the selected SKILL.md package in full.",
			)}
		>
			<div className="space-y-6">
				<div className="rounded-2xl border border-gold-400/10 bg-gold-400/5 p-4 text-sm leading-6 text-gold-100/85">
					<div className="font-semibold text-gold-300">{t("settings.sections.execution_agents.layout_title", "Agent Skills Layout")}</div>
					<div>{t("settings.sections.execution_agents.layout_desc", "`SKILL.md` with YAML frontmatter is required. Optional package content includes `agents/openai.yaml`, `references/`, `scripts/`, and `assets/`.")}</div>
				</div>

				<div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
					<div className="flex items-center gap-2 text-sm font-semibold text-white">
						<FolderTree size={16} />
						<span>{t("settings.sections.execution_agents.roots_title", "Skill Roots")}</span>
					</div>
					<div className="text-xs text-gray-400">
						{t("settings.sections.execution_agents.roots_desc", "Root changes are stored in settings. Save settings to apply added or removed roots before creating packages in them.")}
					</div>
					<div className="space-y-4">
						{configuredRoots.map((root, index) => (
							<div key={`${root.path}-${index}`} className="grid grid-cols-1 gap-3 rounded-xl border border-white/5 bg-black/20 p-4 lg:grid-cols-[1.5fr_1fr_auto_auto]">
								<FormInput
									value={root.path}
									onChange={(value) =>
										updateRoots(
											configuredRoots.map((item, itemIndex) =>
												itemIndex === index ? { ...item, path: value as string } : item,
											),
										)
									}
									placeholder="E:\\skills"
								/>
								<FormInput
									value={root.label || ""}
									onChange={(value) =>
										updateRoots(
											configuredRoots.map((item, itemIndex) =>
												itemIndex === index ? { ...item, label: value as string } : item,
											),
										)
									}
									placeholder="Label"
								/>
								<div className="flex items-center justify-center rounded-xl border border-white/5 bg-black/20 px-4">
									<FormSwitch
										checked={root.enabled}
										onChange={(value) =>
											updateRoots(
												configuredRoots.map((item, itemIndex) =>
													itemIndex === index ? { ...item, enabled: value } : item,
												),
											)
										}
									/>
								</div>
								<Button
									variant="ghost"
									onClick={() => updateRoots(configuredRoots.filter((_, itemIndex) => itemIndex !== index))}
								>
									<Trash2 size={14} />
								</Button>
							</div>
						))}
					</div>
					<div className="flex gap-3">
						<Button
							variant="ghost"
							onClick={() =>
								updateRoots([
									...configuredRoots,
									{ path: "", label: `Root ${configuredRoots.length + 1}`, enabled: true },
								])
							}
						>
							{t("settings.sections.execution_agents.add_root", "Add Root")}
						</Button>
						<Button variant="ghost" onClick={() => void fetchAgentSkills()}>
							<RefreshCw size={14} />
							{t("settings.sections.execution_agents.refresh", "Refresh")}
						</Button>
					</div>
					<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
						{skillRoots.map((root) => (
							<div key={root.path} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-xs text-gray-300">
								<div className="font-semibold text-white">{root.label || root.path}</div>
								<div className="mt-1 break-all text-gray-400">{root.path}</div>
								<div className="mt-2 flex gap-2">
									<span className={`rounded-md px-2 py-1 ${root.enabled ? "bg-emerald-500/10 text-emerald-300" : "bg-white/5 text-gray-500"}`}>
										{root.enabled ? t("settings.sections.execution_agents.enabled", "Enabled") : t("settings.sections.execution_agents.disabled", "Disabled")}
									</span>
									<span className={`rounded-md px-2 py-1 ${root.writable ? "bg-sky-500/10 text-sky-300" : "bg-white/5 text-gray-500"}`}>
										{root.writable ? t("settings.sections.execution_agents.writable", "Writable") : t("settings.sections.execution_agents.readonly", "Read-only")}
									</span>
								</div>
							</div>
						))}
					</div>
				</div>

				<div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
					<div className="space-y-4">
						<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
							<div className="mb-3 text-sm font-semibold text-white">{t("settings.sections.execution_agents.packages_title", "Packages")}</div>
							<div className="mb-3 flex gap-2">
								<FormInput value={newSkillId} onChange={(value) => setNewSkillId(value as string)} placeholder="new-skill" />
								<Button onClick={createNewSkill}>
									<PackagePlus size={14} />
								</Button>
							</div>
							<div className="space-y-2">
								{entries.length === 0 ? (
									<div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-sm text-gray-400">
										{t("settings.sections.execution_agents.no_skills", "No Agent Skills found.")}
									</div>
								) : (
									entries.map((skill) => (
										<button
											type="button"
											key={skill.id}
											onClick={() => setSelectedSkillId(skill.id)}
											className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
												selectedSkillId === skill.id
													? "border-gold-400/40 bg-gold-400/10"
													: "border-white/5 bg-black/20 hover:border-white/10"
											}`}
										>
											<div className="text-sm font-semibold text-white">{skill.name}</div>
											<div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-400">
												{skill.short_description || skill.description}
											</div>
											<div className="mt-2 flex gap-2">
												<span className={`rounded-md px-2 py-1 text-[11px] ${skill.valid ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
													{skill.valid ? t("settings.sections.execution_agents.valid", "Valid") : t("settings.sections.execution_agents.needs_fix", "Needs Fix")}
												</span>
												<span className={`rounded-md px-2 py-1 text-[11px] ${skill.writable ? "bg-sky-500/10 text-sky-300" : "bg-white/5 text-gray-500"}`}>
													{skill.writable ? t("settings.sections.execution_agents.writable", "Writable") : t("settings.sections.execution_agents.readonly", "Read-only")}
												</span>
											</div>
										</button>
									))
								)}
							</div>
						</div>
					</div>

					<div className="space-y-4">
						{isLoadingSkill ? (
							<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-gray-400">
								{t("settings.sections.execution_agents.loading_package", "Loading package...")}
							</div>
						) : !editingSkill ? (
							<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-gray-400">
								{t("settings.sections.execution_agents.select_skill", "Select a skill package to edit.")}
							</div>
						) : (
							<>
								<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
									<div className="mb-4 flex items-center justify-between gap-3">
										<div>
											<div className="text-lg font-semibold text-white">{editingSkill.name}</div>
											<div className="text-xs font-mono text-gray-500">@{editingSkill.id}</div>
										</div>
										<div className="flex gap-2">
											<Button onClick={handleSaveSkill} disabled={isSavingSkill}>
												<Save size={14} />
												{isSavingSkill ? t("settings.sections.execution_agents.saving_skill", "Saving...") : t("settings.sections.execution_agents.save_skill", "Save Skill")}
											</Button>
											<Button variant="ghost" onClick={handleDeleteSkill} disabled={isDeletingSkill}>
												<Trash2 size={14} />
												{t("settings.sections.execution_agents.delete_skill", "Delete")}
											</Button>
										</div>
									</div>

									<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
										<FormGroup label={t("settings.sections.execution_agents.skill_id", "Skill ID")}>
											<FormInput
												value={editingSkill.id}
												onChange={(value) =>
													setEditingSkill({ ...editingSkill, id: value as string, name: value as string })
												}
											/>
										</FormGroup>
										<FormGroup label={t("settings.sections.execution_agents.target_root", "Target Root")}>
											<select
												value={editingSkill.root_path}
												onChange={(event) => setEditingSkill({ ...editingSkill, root_path: event.target.value })}
												className="h-11 w-full rounded-xl border border-white/10 bg-[#0B0E13] px-3 text-sm text-white outline-none focus:border-gold-400/40"
											>
												<option value="">{t("settings.sections.execution_agents.select_root", "Select root")}</option>
												{skillRoots.map((root) => (
													<option key={root.path} value={root.path}>
														{root.label || root.path}
													</option>
												))}
											</select>
										</FormGroup>
									</div>

									<div className="mt-4 space-y-2">
										<div className="text-sm font-semibold text-white">SKILL.md</div>
										<textarea
											value={editingSkill.skill_markdown}
											onChange={(event) => setEditingSkill({ ...editingSkill, skill_markdown: event.target.value })}
											className="min-h-[320px] w-full rounded-2xl border border-white/10 bg-[#0B0E13] p-4 font-mono text-sm text-gray-200 outline-none focus:border-gold-400/40"
											spellCheck={false}
										/>
									</div>

									<div className="mt-4 space-y-2">
										<div className="text-sm font-semibold text-white">agents/openai.yaml</div>
										<textarea
											value={editingSkill.openai_yaml || ""}
											onChange={(event) => setEditingSkill({ ...editingSkill, openai_yaml: event.target.value })}
											className="min-h-[160px] w-full rounded-2xl border border-white/10 bg-[#0B0E13] p-4 font-mono text-sm text-gray-200 outline-none focus:border-gold-400/40"
											spellCheck={false}
										/>
									</div>
								</div>

								<SkillFileListEditor
									title="References"
									files={editingSkill.references}
									onChange={(references) => setEditingSkill({ ...editingSkill, references })}
								/>
								<SkillFileListEditor
									title="Scripts"
									files={editingSkill.scripts}
									onChange={(scripts) => setEditingSkill({ ...editingSkill, scripts })}
								/>
								<SkillFileListEditor
									title="Assets"
									files={editingSkill.assets}
									onChange={(assets) => setEditingSkill({ ...editingSkill, assets })}
								/>
								<SkillFileListEditor
									title="Other"
									files={editingSkill.other_files}
									onChange={(other_files) => setEditingSkill({ ...editingSkill, other_files })}
								/>

								{editingSkill.warnings.length > 0 && (
									<div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100">
										<div className="font-semibold text-red-300">{t("settings.sections.execution_agents.validation_warnings", "Validation Warnings")}</div>
										<div className="mt-2 whitespace-pre-wrap">{editingSkill.warnings.join("\n")}</div>
									</div>
								)}
							</>
						)}
					</div>
				</div>
			</div>
		</SettingsSection>
	);
};

export default AgentSkillsSettings;
