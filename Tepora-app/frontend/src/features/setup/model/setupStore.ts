import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SetupStep, InternetPreference, PersonaPreference } from "./setupTypes";

interface SetupState {
	// Active step
	step: SetupStep;
	
	// Language selection
	language: string | null;
	
	// Preferences
	internetPreference: InternetPreference | null;
	personaPreference: PersonaPreference | null;
	
	// Model Selection (for Smart Setup Step)
	selectedModelKeys: Record<string, boolean>;
	
	// Actions
	setStep: (step: SetupStep) => void;
	setLanguage: (lang: string) => void;
	setPreference: (internet: InternetPreference, persona: PersonaPreference) => void;
	toggleModelKey: (key: string, enabled: boolean) => void;
	reset: () => void;
}

export const useSetupStore = create<SetupState>()(
	persist(
		(set) => ({
			step: "language",
			language: null,
			internetPreference: null,
			personaPreference: null,
			selectedModelKeys: {},

			setStep: (step) => set({ step }),
			
			setLanguage: (language) => set({ language }),
			
			setPreference: (internetPreference, personaPreference) => 
				set({ internetPreference, personaPreference }),
				
			toggleModelKey: (key, enabled) => 
				set((state) => ({
					selectedModelKeys: {
						...state.selectedModelKeys,
						[key]: enabled
					}
				})),
				
			reset: () => set({
				step: "language",
				language: null,
				internetPreference: null,
				personaPreference: null,
				selectedModelKeys: {}
			}),
		}),
		{
			name: "tepora-setup-storage",
		}
	)
);
