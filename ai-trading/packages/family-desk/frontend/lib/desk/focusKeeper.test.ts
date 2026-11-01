import assert from "node:assert/strict";
import test from "node:test";
import { focusLost, focusTarget } from "./focusKeeper.ts";

// Stand-ins: the module only asks `contains` and `querySelector`.
const body = {} as Element;
const inside = {} as Element;
const chrome = {} as Element;
const main = { contains: (node: unknown) => node === inside, querySelector: () => null } as unknown as HTMLElement;

test("focus goes to the page's h1, else to the main region", () => {
  const h1 = {} as HTMLElement;
  assert.equal(focusTarget({ ...main, querySelector: (selector: string) => (selector === "h1" ? h1 : null) } as unknown as HTMLElement), h1);
  assert.equal(focusTarget(main), main);
});

test("focus on the body or on nothing is lost, with or without a route change", () => {
  for (const routeChanged of [false, true]) {
    assert.equal(focusLost(body, body, main, routeChanged), true);
    assert.equal(focusLost(null, body, main, routeChanged), true);
  }
});

test("focus on a control inside the page is never lost", () => {
  assert.equal(focusLost(inside, body, main, false), false);
  assert.equal(focusLost(inside, body, main, true), false);
});

test("focus in the chrome is lost only after a route change, so a removed control never pulls focus off the search box", () => {
  assert.equal(focusLost(chrome, body, main, false), false);
  assert.equal(focusLost(chrome, body, main, true), true);
});

test("focus on the main region itself counts as lost after a route change, so the h1 gets it", () => {
  assert.equal(focusLost(main, body, main, true), true);
  assert.equal(focusLost(main, body, main, false), false);
});
