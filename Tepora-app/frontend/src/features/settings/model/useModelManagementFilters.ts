import { useMemo, useState } from "react";
import type { SetupModel } from "../../../shared/contracts";
import { normalizeModelRole } from "../../../shared/lib/modelManagement";
import type { ModelRoleFilter } from "./modelManagementTypes";

function matchesSearch(model: SetupModel, searchTerm: string) {
	if (!searchTerm) {
		return true;
	}

	const normalizedSearch = searchTerm.toLowerCase();
	return (
		model.display_name.toLowerCase().includes(normalizedSearch) ||
		model.filename?.toLowerCase().includes(normalizedSearch)
	);
}

export function useModelManagementFilters(models: SetupModel[]) {
	const [activeRole, setActiveRole] = useState<ModelRoleFilter>("all");
	const [searchTerm, setSearchTerm] = useState("");

	const normalizedModels = useMemo(
		() =>
			models.map((model) => ({
				...model,
				role: normalizeModelRole(model.role),
			})),
		[models],
	);

	const filteredModels = useMemo(
		() =>
			normalizedModels.filter((model) => {
				if (activeRole !== "all" && model.role !== activeRole) {
					return false;
				}
				return matchesSearch(model, searchTerm);
			}),
		[activeRole, normalizedModels, searchTerm],
	);

	const remoteModels = useMemo(
		() => normalizedModels.filter((model) => Boolean(model.repo_id)),
		[normalizedModels],
	);

	const clearFilters = () => {
		setSearchTerm("");
		setActiveRole("all");
	};

	return {
		activeRole,
		setActiveRole,
		searchTerm,
		setSearchTerm,
		filteredModels,
		remoteModels,
		clearFilters,
	};
}
