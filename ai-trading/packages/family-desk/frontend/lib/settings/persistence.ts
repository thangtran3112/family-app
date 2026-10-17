export function settingsControlsDisabled({
  loading,
  saving,
  hasSettings,
}: Readonly<{ loading: boolean; saving: boolean; hasSettings: boolean }>): boolean {
  return loading || saving || !hasSettings;
}

export function createSingleFlightSettingsSave() {
  let pending = false;
  let active = true;

  return {
    async run<T>(write: () => Promise<T>): Promise<
      { status: "saved"; value: T } | { status: "busy" | "error" | "disposed" }
    > {
      if (!active) return { status: "disposed" };
      if (pending) return { status: "busy" };

      pending = true;
      try {
        const value = await write();
        return active ? { status: "saved", value } : { status: "disposed" };
      } catch {
        return active ? { status: "error" } : { status: "disposed" };
      } finally {
        pending = false;
      }
    },
    dispose() {
      active = false;
    },
  };
}
