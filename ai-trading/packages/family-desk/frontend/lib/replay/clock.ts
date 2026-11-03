// The speeds the thread's clock runs at (ADR-0018, ADR-0025): 1x, 2x, 5x or 10x market seconds per wall second. The clock lives on the server and
// is moved only at the thread (Play, Pause, speed, Jump, Next open); a lane's chart never moves it.

export const SPEEDS = [1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 1;

export const isSpeed = (value: number): value is Speed => (SPEEDS as readonly number[]).includes(value);
