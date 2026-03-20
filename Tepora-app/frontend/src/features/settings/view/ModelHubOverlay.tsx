import React from "react";
import { useTranslation } from "react-i18next";
import { ModelManagementSection } from "./ModelManagementSection";
import { Modal } from "../../../shared/ui/Modal";

interface ModelHubOverlayProps {
	isOpen: boolean;
	onClose: () => void;
}

export const ModelHubOverlay: React.FC<ModelHubOverlayProps> = ({
	isOpen,
	onClose,
}) => {
	const { t } = useTranslation();

	return (
		<Modal
			isOpen={isOpen}
			onClose={onClose}
			title={t("modelHub.title", "Model Hub")}
			size="xl"
		>
			<div className="mb-5 text-sm leading-7 text-text-muted">
				{t(
					"v2.settings.modelHubDescription",
					"Browse installed models, download new ones, and update runtime binaries from one place.",
				)}
			</div>
			<ModelManagementSection />
		</Modal>
	);
};
