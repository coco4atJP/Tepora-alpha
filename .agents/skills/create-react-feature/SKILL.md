# Create React Feature Skill

## Description
Generates a complete set of files for a new React feature component, including the implementation, tests, and export definition, tailored for the Tepora Project stack (React 19, TypeScript, Tailwind CSS v4, Vitest).

## Usage
Activate this skill when the user asks to create a new UI component, add a feature to the frontend, or scaffold a React component.

## Dependencies
- React v19
- TypeScript
- Tailwind CSS v4
- Vitest
- Lucide React (for icons)

## Instructions

When this skill is activated, follow these steps:

1.  **Clarify Requirements**:
    If not provided, ask the user for:
    - **Component Name** (PascalCase, e.g., `UserProfile`, `SettingsPanel`).
    - **Target Directory** (Default to `frontend/src/components/ui` for generic UI or `frontend/src/features/[feature-name]` for specific features).
    - **Purpose/Functionality** (Brief description of what it does).

2.  **Generate Files**:
    Create a new directory named after the component (or use existing) and generate the following files inside it.

    **File 1: `[ComponentName].tsx`**
    - Use Functional Component syntax with `export const`.
    - Define a Props interface `[ComponentName]Props`.
    - Use Tailwind CSS classes for styling.
    - Implement basic structure based on the user's description.
    - Import icons from `lucide-react` if needed.

    **Template:**
    ```tsx
    import React from 'react';
    import { cn } from '@/lib/utils'; // Assuming a utility for class merging exists, otherwise use template literals
    
    interface [ComponentName]Props {
      className?: string;
      // Add other props here
    }

    export const [ComponentName]: React.FC<[ComponentName]Props> = ({ className, ...props }) => {
      return (
        <div className={cn("p-4 bg-white rounded-lg shadow-sm border border-gray-100", className)} {...props}>
          <h2 className="text-lg font-semibold text-gray-900">[ComponentName]</h2>
          <p className="text-gray-500 mt-2">Component content goes here.</p>
        </div>
      );
    };
    ```

    **File 2: `[ComponentName].test.tsx`**
    - Use `vitest` and `@testing-library/react`.
    - Include a basic render test and a snapshot test (optional) or checking for text presence.

    **Template:**
    ```tsx
    import { render, screen } from '@testing-library/react';
    import { describe, it, expect } from 'vitest';
    import { [ComponentName] } from './[ComponentName]';

    describe('[ComponentName]', () => {
      it('renders correctly', () => {
        render(<[ComponentName] />);
        expect(screen.getByText('[ComponentName]')).toBeInTheDocument();
      });
    });
    ```

    **File 3: `index.ts`**
    - Export the component.

    **Template:**
    ```ts
    export * from './[ComponentName]';
    ```

3.  **Review**:
    Show the file paths to be created and ask for confirmation before writing, unless the user gave explicit "do it" permission.

4.  **Post-Creation**:
    After creating files, suggest running tests: `npm run test` or `npx vitest`.

## Context Awareness
- Check `frontend/tsconfig.json` for path aliases (e.g., `@/`) before importing.
- Check if `cn` (classnames utility) exists in `frontend/src/lib/utils.ts` or similar. If not, use template literals or suggest creating it.
