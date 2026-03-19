import React from "react";
import { LineSlider } from "../../../../shared/ui/LineSlider";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";

export const ContextSettings: React.FC = () => {
	const editor = useSettingsEditor();
	const ragResults = editor.readNumber("rag.search_default_limit", 5);
	const textResults = editor.readNumber("rag.text_search_default_limit", 10);
	const chunkWindow = editor.readNumber("rag.chunk_window_default_chars", 1200);
	const rerank = editor.readBoolean("search.embedding_rerank", false);

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="RAG">
				<SettingsRow
					label="Search Results"
					description="Number of vector search chunks retrieved per query"
				>
					<LineSlider
						min={1}
						max={20}
						value={ragResults}
						onChange={(value) =>
							editor.updateField("rag.search_default_limit", value)
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="Text Search Results"
					description="Maximum number of text-search matches returned"
				>
					<LineSlider
						min={1}
						max={50}
						value={textResults}
						onChange={(value) =>
							editor.updateField("rag.text_search_default_limit", value)
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="Embedding Rerank"
					description="Apply embedding reranking when building retrieval context"
				>
					<MinToggle
						checked={rerank}
						onChange={(checked) =>
							editor.updateField("search.embedding_rerank", checked)
						}
						label={rerank ? "Enabled" : "Disabled"}
					/>
				</SettingsRow>
			</SettingsSectionGroup>

			<SettingsSectionGroup title="Window Allocation">
				<SettingsRow
					label="Chunk Window"
					description="Default context expansion window used around retrieved chunks"
				>
					<div className="w-full max-w-xs">
						<TextField
							type="number"
							value={chunkWindow}
							onChange={(event) =>
								editor.updateField(
									"rag.chunk_window_default_chars",
									Number(event.target.value) || 0,
								)
							}
							min={128}
							max={20000}
						/>
					</div>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
