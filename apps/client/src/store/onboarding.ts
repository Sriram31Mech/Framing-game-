/**
 * Onboarding (story intro + guided tour with Muthu Thatha). Persisted in localStorage so the tour
 * resumes after a reload; resets when a different company is played.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TourStepId =
  'find_land' | 'open_plot' | 'plant' | 'grow' | 'harvest' | 'sell' | 'finance';

export const TOUR_STEPS: TourStepId[] = [
  'find_land',
  'open_plot',
  'plant',
  'grow',
  'harvest',
  'sell',
  'finance',
];

export const XP_PER_STEP = 50;

interface OnboardingState {
  /** Company this progress belongs to. */
  companyId: string | null;
  storyDone: boolean;
  completed: TourStepId[];
  /** Skipped or finished; the "Ask Thatha" button brings it back. */
  dismissed: boolean;
  /** Voice off. */
  muted: boolean;
  init: (companyId: string) => void;
  finishStory: () => void;
  complete: (step: TourStepId) => void;
  dismiss: () => void;
  resume: () => void;
  setMuted: (muted: boolean) => void;
}

export const useOnboarding = create<OnboardingState>()(
  persist(
    (set, get) => ({
      companyId: null,
      storyDone: false,
      completed: [],
      dismissed: false,
      muted: false,
      init(companyId) {
        if (get().companyId === companyId) return;
        set({ companyId, storyDone: false, completed: [], dismissed: false });
      },
      finishStory: () => set({ storyDone: true }),
      complete(step) {
        if (!get().completed.includes(step)) set({ completed: [...get().completed, step] });
      },
      dismiss: () => set({ dismissed: true, storyDone: true }),
      resume: () => set({ dismissed: false, storyDone: true }),
      setMuted: (muted) => set({ muted }),
    }),
    { name: 'bh-onboarding-v2' },
  ),
);

/** First step not yet completed, or null when the tour is finished. */
export function currentTourStep(completed: TourStepId[]): TourStepId | null {
  return TOUR_STEPS.find((s) => !completed.includes(s)) ?? null;
}

/** True while the story or tour owns the guide slot (NextStepCard stays hidden). */
export function useTourActive(companyId: string): boolean {
  return useOnboarding((s) => s.companyId !== companyId || !s.dismissed);
}
