/**
 * Onboarding state: tracks which tutorial steps the player has completed.
 * Persisted in localStorage so it survives page reloads but resets on a new company.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type OnboardingStep =
  'welcome' | 'inspect_land' | 'buy_or_lease' | 'plant_crop' | 'harvest' | 'sell';

const STEPS: OnboardingStep[] = [
  'welcome',
  'inspect_land',
  'buy_or_lease',
  'plant_crop',
  'harvest',
  'sell',
];

interface OnboardingState {
  /** Company id this onboarding belongs to (resets when a new company is created). */
  companyId: string | null;
  completed: Set<OnboardingStep>;
  dismissed: boolean;
  /** Mark a step done and advance. */
  complete: (step: OnboardingStep) => void;
  /** Permanently hide the onboarding for this company. */
  dismiss: () => void;
  /** Reset when a new company is created. */
  init: (companyId: string) => void;
  currentStep: () => OnboardingStep | null;
  isDone: () => boolean;
}

export const useOnboarding = create<OnboardingState>()(
  persist(
    (set, get) => ({
      companyId: null,
      completed: new Set(),
      dismissed: false,

      init(companyId) {
        if (get().companyId === companyId) return;
        set({ companyId, completed: new Set(), dismissed: false });
      },

      complete(step) {
        const next = new Set(get().completed);
        next.add(step);
        set({ completed: next });
      },

      dismiss() {
        set({ dismissed: true });
      },

      currentStep() {
        const { completed, dismissed } = get();
        if (dismissed) return null;
        return STEPS.find((s) => !completed.has(s)) ?? null;
      },

      isDone() {
        return STEPS.every((s) => get().completed.has(s));
      },
    }),
    {
      name: 'bh-onboarding',
      // Serialize Set as array.
      storage: {
        getItem: (key) => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          const parsed = JSON.parse(raw) as {
            state: { completed: OnboardingStep[]; companyId: string | null; dismissed: boolean };
          };
          return {
            ...parsed,
            state: { ...parsed.state, completed: new Set(parsed.state.completed) },
          };
        },
        setItem: (key, value) => {
          const serializable = {
            ...value,
            state: { ...value.state, completed: [...value.state.completed] },
          };
          localStorage.setItem(key, JSON.stringify(serializable));
        },
        removeItem: (key) => localStorage.removeItem(key),
      },
    },
  ),
);
