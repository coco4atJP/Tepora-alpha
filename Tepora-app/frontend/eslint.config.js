import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

const FEATURE_NAMES = ["chat", "navigation", "session", "settings"];
const FEATURE_BOUNDARY_EXCEPTIONS = [
	"src/features/chat/PersonaSwitcher.tsx",
	"src/features/navigation/Layout.tsx",
	"src/features/chat/model/useChatScreenModel.ts",
	"src/features/chat/view/ChatMessageList.tsx",
	"src/features/chat/view/QuickPersonaSwitcher.tsx",
];
const REFRESH_EXPORT_EXCEPTIONS = [
	"src/app/router.tsx",
	"src/features/settings/model/editor.tsx",
];

function createFeatureBoundaryConfig(featureName) {
	const crossFeatureTargets = FEATURE_NAMES.filter((name) => name !== featureName).join("|");
	const boundaryMessage = `Do not import other features from "${featureName}". Move shared code to a common layer outside src/features.`;

	return {
		files: [`src/features/${featureName}/**/*.{ts,tsx}`],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							regex: `^(\\.\\./)+(?:${crossFeatureTargets})(?:/|$)`,
							message: boundaryMessage,
						},
						{
							regex: `^(\\.\\./)+features/(?:${crossFeatureTargets})(?:/|$)`,
							message: boundaryMessage,
						},
						{
							regex: `^(?:@/|src/)?features/(?:${crossFeatureTargets})(?:/|$)`,
							message: boundaryMessage,
						},
					],
				},
			],
		},
	};
}

export default tseslint.config(
	{ ignores: ["dist", "src-tauri", "node_modules", "coverage", "src/legacy"] },
	{
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
		},
		plugins: {
			"react-hooks": reactHooks,
			"react-refresh": reactRefresh,
		},
		rules: {
			...reactHooks.configs.recommended.rules,
			"react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
		},
	},
	...FEATURE_NAMES.map(createFeatureBoundaryConfig),
	{
		files: FEATURE_BOUNDARY_EXCEPTIONS,
		rules: {
			"no-restricted-imports": "off",
		},
	},
	{
		files: REFRESH_EXPORT_EXCEPTIONS,
		rules: {
			"react-refresh/only-export-components": "off",
		},
	},
);
