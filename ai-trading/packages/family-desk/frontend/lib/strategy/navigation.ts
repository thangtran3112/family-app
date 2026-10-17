export function navigateToStrategyBuilder(
  strategyId: number,
  location: Pick<Location, "assign"> = window.location,
): void {
  // A document entry makes Back from the builder trigger its beforeunload guard.
  location.assign(`/strategies?id=${strategyId}`);
}
