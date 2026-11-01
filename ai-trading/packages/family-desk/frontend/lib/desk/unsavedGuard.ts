/** The `beforeunload` handler of a form with unsaved changes: the browser asks before it closes or reloads the page. */
export function warnBeforeUnload(event: { preventDefault(): void; returnValue?: unknown }): void {
  event.preventDefault();
  event.returnValue = ""; // older browsers only ask when this is set
}
