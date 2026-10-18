export function runTask7WithIsolatedAppApi({
  appApiWasRunning,
  appApiIsRunning,
  stopAppApi,
  runTask7,
  startAppApi,
}) {
  if (appApiWasRunning) {
    throw new Error("Task 7 isolation refused: pre-existing App API must not be stopped");
  }

  if (!appApiIsRunning) return runTask7();

  stopAppApi();
  try {
    return runTask7();
  } finally {
    startAppApi();
  }
}
