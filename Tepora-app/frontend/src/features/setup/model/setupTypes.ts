import { z } from "zod";

// Setup Flow Steps
export const setupStepSchema = z.enum([
	"language",
	"preference",
	"smart_setup",
	"ready",
]);

export type SetupStep = z.infer<typeof setupStepSchema>;

// Preference Types
export const internetPreferenceSchema = z.enum(["on", "off"]);
export type InternetPreference = z.infer<typeof internetPreferenceSchema>;

export const personaPreferenceSchema = z.enum(["character", "assistant"]);
export type PersonaPreference = z.infer<typeof personaPreferenceSchema>;

// Smart Setup Detection Pattern
export const setupPatternSchema = z.enum([
	"A_READY",          // Internet ON, Runtime Detected, Embedding Detected
	"B_DOWNLOAD_ALL",   // Internet ON, No Runtime Detected (Download llama.cpp models)
	"C_DOWNLOAD_EMBED", // Internet ON, Runtime Detected, No Embedding
	"D_OFFLINE_NO_RUN", // Internet OFF, No Runtime Detected (Fallback to local file / Error)
	"E_OFFLINE_READY"   // Internet OFF, Runtime Detected
]);

export type SetupPattern = z.infer<typeof setupPatternSchema>;
