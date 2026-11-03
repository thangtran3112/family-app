// What a lane's workspace needs beyond `marks.ts`: the exit mark that closes a side. (The swing view, its Daily chart, the day strip, the
// stop pause and the plan checklist are gone with the swing model, ADR-0025: a lane is a chart of the thread's time, and a stop is an alert flag.)

export const exitKindFor = (side: "long" | "short"): "long_exit" | "short_exit" => (side === "long" ? "long_exit" : "short_exit");
