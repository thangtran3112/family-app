import { z } from "zod";

// The server refused a scan (409) because every filter waits for its first bar: that is a fact about the thread and its clock minute, not about the
// page that asked (D-234, D-239). It is kept per thread in the tab's session storage, so leaving the Screen and coming back, or a reload, at the same
// minute still finds the button off and the sentence up. `minuteOfClock` decides when it is old news; a stale entry is harmless and is overwritten by the next one.

export const SCREEN_REFUSAL_KEY = "desk.screenRefusal";

export type ScreenRefusal = { minute: number; reason: string };

const RefusalSchema = z.object({ minute: z.number().finite(), reason: z.string() });

type RefusalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyOf = (threadId: number): string => `${SCREEN_REFUSAL_KEY}:${threadId}`;

export function readScreenRefusal(storage: RefusalStorage | null, threadId: number): ScreenRefusal | null {
  try {
    const raw = storage?.getItem(keyOf(threadId));
    return raw ? RefusalSchema.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeScreenRefusal(storage: RefusalStorage | null, threadId: number, refusal: ScreenRefusal | null): void {
  try {
    if (refusal === null) storage?.removeItem(keyOf(threadId));
    else storage?.setItem(keyOf(threadId), JSON.stringify(refusal));
  } catch {
    // Private mode or a full quota: the refusal stays on this page until it is left.
  }
}
