import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { V2Config } from "../../../shared/contracts";
import {
	useSaveV2ConfigMutation,
	useV2ConfigQuery,
} from "../../settings/model/queries";

export const QuickCharacterSwitcher: React.FC = () => {
	const { t } = useTranslation();
	const { data: config } = useV2ConfigQuery();
	const { mutate: saveConfig, isPending } = useSaveV2ConfigMutation();
	const [isOpen, setIsOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	const characters = useMemo(() => {
		if (!config?.characters || typeof config.characters !== "object") {
			return [];
		}

		return Object.entries(config.characters as Record<string, Record<string, unknown>>).map(
			([id, character]) => ({
				id,
				name: String(character.name ?? id),
				description: String(character.description ?? ""),
				icon: String(character.icon ?? "•"),
			}),
		);
	}, [config?.characters]);

	const activeProfileId =
		typeof config?.active_character === "string"
			? config.active_character
			: typeof config?.active_character === "string"
			? config.active_character
			: characters[0]?.id;
	const activeCharacter =
		characters.find((character) => character.id === activeProfileId) ?? characters[0] ?? null;
	type CharacterConfigPatch = Pick<V2Config, "active_character">;

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				dropdownRef.current &&
				!dropdownRef.current.contains(event.target as Node)
			) {
				setIsOpen(false);
			}
		};

		if (isOpen) {
			document.addEventListener("mousedown", handleClickOutside);
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [isOpen]);

	if (!activeCharacter) {
		return null;
	}

	return (
		<div className="relative pointer-events-auto" ref={dropdownRef}>
			<button
				type="button"
				onClick={() => setIsOpen((current) => !current)}
				className="flex min-w-[14rem] items-center gap-3 rounded-full border border-[color:var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2 text-left shadow-[var(--glass-shadow)] backdrop-blur-md transition-all hover:border-primary/20 hover:bg-surface/80"
				title={t("v2.character.switch", "Switch character")}
			>
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-lg text-primary">
					<span aria-hidden="true">{activeCharacter.icon}</span>
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-text-main">
						{activeCharacter.name}
					</div>
					<div className="truncate text-[0.68rem] uppercase tracking-[0.16em] text-text-muted">
						{t("v2.character.active", "Active character")}
					</div>
				</div>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted">
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>

			{isOpen ? (
				<div className="absolute right-0 top-full z-50 mt-3 flex min-w-[18rem] flex-col overflow-hidden rounded-[24px] border border-border bg-bg/95 p-2 shadow-[0_20px_50px_rgba(59,38,20,0.12)] backdrop-blur-xl">
					<div className="px-3 py-2 text-[0.68rem] uppercase tracking-[0.18em] text-text-muted">
						{t("v2.character.available", "Available characters")}
					</div>
					<div className="custom-scrollbar flex max-h-80 flex-col gap-1 overflow-y-auto">
						{characters.map((character) => {
							const selected = character.id === activeProfileId;
							return (
								<button
									type="button"
									key={character.id}
									onClick={() => {
										if (!selected) {
											saveConfig({
												active_character: character.id,
											} satisfies CharacterConfigPatch);
										}
										setIsOpen(false);
									}}
									disabled={isPending}
									className={`flex items-start gap-3 rounded-[20px] px-3 py-3 text-left transition-colors ${
										selected
											? "bg-primary/10 text-primary"
											: "text-text-main hover:bg-surface/60"
									}`}
								>
									<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base">
										<span aria-hidden="true">{character.icon}</span>
									</div>
									<div className="min-w-0 flex-1">
										<div className="truncate text-sm font-medium">
											{character.name}
										</div>
										<div className="mt-1 max-h-10 overflow-hidden text-xs leading-5 text-text-muted">
											{character.description || t("v2.character.noDescription", "No description")}
										</div>
									</div>
								</button>
							);
						})}
					</div>
				</div>
			) : null}
		</div>
	);
};
