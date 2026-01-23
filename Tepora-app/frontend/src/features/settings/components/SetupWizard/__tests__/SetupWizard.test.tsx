import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback: string) => fallback || key,
		i18n: {
			changeLanguage: vi.fn().mockResolvedValue(undefined),
		},
	}),
}));

// Mock requirements hook to avoid QueryClient dependency in unit tests
vi.mock("../../../../../hooks/useServerConfig", () => ({
	useRequirements: () => ({
		refetch: vi
			.fn()
			.mockResolvedValue({ data: { is_ready: true }, error: null }),
	}),
}));

import CompleteStep from "../steps/CompleteStep";
import ErrorStep from "../steps/ErrorStep";
import InstallingStep from "../steps/InstallingStep";
// Import components after mocks
import LanguageStep from "../steps/LanguageStep";
import RequirementsCheckStep from "../steps/RequirementsCheckStep";

describe("SetupWizard Steps", () => {
	console.log("Test suite loaded");
	describe("LanguageStep", () => {
		it("renders all language options", () => {
			const onSelectLanguage = vi.fn();
			render(<LanguageStep onSelectLanguage={onSelectLanguage} />);

			const englishElements = screen.getAllByText("English");
			expect(englishElements.length).toBeGreaterThan(0);
			expect(screen.getByText("日本語")).toBeInTheDocument();
			expect(screen.getByText("中文")).toBeInTheDocument();
			expect(screen.getByText("Español")).toBeInTheDocument();
		});

		it("calls onSelectLanguage when a language is clicked", () => {
			const onSelectLanguage = vi.fn();
			render(<LanguageStep onSelectLanguage={onSelectLanguage} />);

			fireEvent.click(screen.getByText("日本語"));
			expect(onSelectLanguage).toHaveBeenCalledWith("ja");
		});

		it("renders flag emojis", () => {
			const onSelectLanguage = vi.fn();
			render(<LanguageStep onSelectLanguage={onSelectLanguage} />);

			expect(screen.getByText("🇺🇸")).toBeInTheDocument();
			expect(screen.getByText("🇯🇵")).toBeInTheDocument();
		});
	});

	describe("RequirementsCheckStep", () => {
		it("renders loading state", () => {
			render(<RequirementsCheckStep />);

			// Check for the loading spinner (Loader2 icon)
			const loader = document.querySelector(".animate-spin");
			expect(loader).toBeInTheDocument();
		});
	});

	describe("InstallingStep", () => {
		it("renders progress correctly", () => {
			const progress = {
				status: "downloading",
				progress: 0.5,
				message: "Downloading model...",
			};

			render(<InstallingStep progress={progress} />);

			expect(screen.getByText("50%")).toBeInTheDocument();
			expect(screen.getByText("50%")).toBeInTheDocument();
			expect(screen.getByText("Downloading AI models...")).toBeInTheDocument();
		});

		it("shows extracting status", () => {
			const progress = {
				status: "extracting",
				progress: 0.75,
				message: "Extracting files...",
			};

			render(<InstallingStep progress={progress} />);

			expect(screen.getByText("75%")).toBeInTheDocument();
			expect(screen.getByText("Extracting components...")).toBeInTheDocument();
		});
	});

	describe("CompleteStep", () => {
		it("renders completion message", () => {
			const onFinish = vi.fn();
			render(<CompleteStep onFinish={onFinish} />);

			expect(screen.getByText("All Set!")).toBeInTheDocument();
			expect(
				screen.getByText("Tepora is ready to be your AI companion."),
			).toBeInTheDocument();
		});

		it("calls onFinish when button is clicked", () => {
			const onFinish = vi.fn();
			render(<CompleteStep onFinish={onFinish} />);

			fireEvent.click(screen.getByText("Launch Tepora"));
			expect(onFinish).toHaveBeenCalled();
		});
	});

	describe("ErrorStep", () => {
		it("renders error message", () => {
			const onRetry = vi.fn();
			render(
				<ErrorStep
					error="Something went wrong"
					onRetry={onRetry}
					onSkip={undefined}
				/>,
			);

			expect(screen.getByText("Setup Failed")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong")).toBeInTheDocument();
		});

		it("calls onRetry when retry button is clicked", () => {
			const onRetry = vi.fn();
			render(
				<ErrorStep error="Test error" onRetry={onRetry} onSkip={undefined} />,
			);

			fireEvent.click(screen.getByText("Retry"));
			expect(onRetry).toHaveBeenCalled();
		});

		it("renders skip button when onSkip is provided", () => {
			const onRetry = vi.fn();
			const onSkip = vi.fn();
			render(
				<ErrorStep error="Test error" onRetry={onRetry} onSkip={onSkip} />,
			);

			expect(screen.getByText("Skip")).toBeInTheDocument();
			fireEvent.click(screen.getByText("Skip"));
			expect(onSkip).toHaveBeenCalled();
		});

		it("does not render skip button when onSkip is not provided", () => {
			const onRetry = vi.fn();
			render(
				<ErrorStep error="Test error" onRetry={onRetry} onSkip={undefined} />,
			);

			expect(screen.queryByText("Skip")).not.toBeInTheDocument();
		});
	});
});

import SetupWizard from "../SetupWizard";

describe("SetupWizard Integration", () => {
	it("renders skip button in header when onSkip is provided", () => {
		const onComplete = vi.fn();
		const onSkip = vi.fn();
		render(<SetupWizard onComplete={onComplete} onSkip={onSkip} />);

		const skipButton = screen.getByText("Skip Setup");
		expect(skipButton).toBeInTheDocument();
		fireEvent.click(skipButton);
		expect(onSkip).toHaveBeenCalled();
	});

	it("does not render skip button in header when onSkip is not provided", () => {
		const onComplete = vi.fn();
		render(<SetupWizard onComplete={onComplete} />);

		const skipButton = screen.queryByText("Skip Setup");
		expect(skipButton).not.toBeInTheDocument();
	});
});
