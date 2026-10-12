/**
 * Thatha's voice: ONE speaker for the whole app (Web Speech API, en-IN then ta-IN voice).
 * Lines are keyed (story beat / tour step), not compared by text, so a data refetch that tweaks
 * the wording never restarts or stacks speech. A new key cancels the old line and waits a short
 * beat before speaking, which avoids browsers (Safari, Chrome) playing two utterances at once.
 * Returns true while the line is "spoken" so the character can move its mouth; when muted or
 * unsupported the mouth still moves for a reading-length moment.
 */
import { useEffect, useEffectEvent, useState } from 'react';

const GAP_MS = 220;

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const lang = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-');
  return (
    voices.find((v) => lang(v) === 'en-IN') ??
    voices.find((v) => lang(v) === 'ta-IN') ??
    voices.find((v) => lang(v).startsWith('en'))
  );
}

function synth(): SpeechSynthesis | undefined {
  return typeof window !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
    ? window.speechSynthesis
    : undefined;
}

/** Module-level speaker so two components (or StrictMode's double effects) never overlap. */
let token = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function stopVoice() {
  token++;
  clearTimeout(timer);
  synth()?.cancel();
}

function speak(text: string, onDone: () => void): () => void {
  const s = synth();
  stopVoice();
  const mine = token;
  if (!s) {
    timer = setTimeout(onDone, Math.min(6000, 600 + text.length * 45));
    return stopVoice;
  }
  timer = setTimeout(() => {
    if (mine !== token) return;
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(s.getVoices());
    u.lang = voice?.lang ?? 'en-IN';
    if (voice) u.voice = voice;
    u.rate = 0.95;
    u.pitch = 0.8;
    u.onend = u.onerror = () => {
      if (mine === token) onDone();
    };
    s.speak(u);
  }, GAP_MS);
  return () => {
    if (mine === token) stopVoice();
  };
}

/**
 * Speak `text` once per `lineKey`. Changing only the text keeps the current line playing;
 * changing the key (or muting) replaces it.
 */
export function useVoice(lineKey: string | null, text: string, muted: boolean): boolean {
  const [doneKey, setDoneKey] = useState<string | null>(null);
  // Reads the latest text when a line starts, without restarting it when only the text changes.
  const start = useEffectEvent((key: string) => {
    const finish = () => setDoneKey(key);
    if (!muted) return speak(text, finish);
    stopVoice();
    const t = setTimeout(finish, Math.min(6000, 600 + text.length * 45));
    return () => clearTimeout(t);
  });

  useEffect(() => (lineKey ? start(lineKey) : undefined), [lineKey, muted]);

  // Never leave Thatha talking after the guide closes or the page hides.
  useEffect(() => {
    const onHide = () => document.hidden && stopVoice();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      stopVoice();
    };
  }, []);

  return lineKey !== null && doneKey !== lineKey;
}
