// The Desk's colours as TypeScript constants, for canvas and SVG, which cannot read CSS variables (lightweight-charts takes
// plain colour strings). Each base colour repeats a token in app/globals.css; chartPalette.test.ts fails if the two drift.
// Chart code imports from here and never writes a colour literal.

export const chartPalette = {
  ground: "#000000", // --color-ground
  hairline: "#2C2C30", // --color-hairline
  text: "#F2F2F4", // --color-text
  muted: "#9B9BA1", // --color-muted
  amber: "#FFB020", // --color-amber
  up: "#30D158", // --color-up
  down: "#FF453A", // --color-down
  ai: "#A78BFA", // --color-ai
  /** The line and area colour of a price series: not white (EMA 9), not green or red (those mean up and down). */
  price: "#64D2FF", // --color-chart-price
  alt: "#E5E5EA", // --color-chart-alt
  // Alpha variants and fixed fills. The parity test checks each against its base colour.
  mutedFaint: "#9B9BA166", // muted at 40%: reference lines, the neutral gauge arc
  downHalf: "#FF453A80", // down at 50%: the weak-sell gauge arc
  upHalf: "#30D15880", // up at 50%: the weak-buy gauge arc
  priceFillTop: "rgba(100,210,255,0.24)", // price at 24%: top of the area-series fill
  priceFillBottom: "rgba(100,210,255,0)", // price at 0%: bottom of the area-series fill
  clear: "rgba(0,0,0,0)",
} as const;
