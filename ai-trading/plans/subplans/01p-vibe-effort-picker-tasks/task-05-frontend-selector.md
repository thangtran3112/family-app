# Task 5: Frontend selector — `ReasoningEffortSelect`, `ModelRuntimeBar`, `api.ts`, i18n

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints and Review Focus first. No backend dependency — can run any time after (or in parallel with) Tasks 1–4; Task 6 depends on this task's exports.

**Goal:** Replace `ModelRuntimeBar`'s always-read-only effort badge with a native `<select>` (`ReasoningEffortSelect`) fed by the existing `api.listReasoningEfforts`, keep the badge as the fallback when the model has no reasoning control or the probe fails, and give `api.sendMessage` an optional `reasoning_effort` body field.

All paths are relative to `ai-trading/packages/vibe-trading/frontend/` unless noted.

**Files:**
- Modify: `src/lib/api.ts`, `src/components/chat/ModelRuntimeBar.tsx`
- Create: `src/components/chat/ReasoningEffortSelect.tsx`
- Modify/Test: `src/lib/__tests__/api.test.ts`, `src/components/chat/__tests__/ModelRuntimeBar.test.tsx`
- Create/Test: `src/components/chat/__tests__/ReasoningEffortSelect.test.tsx`
- Modify: `src/i18n/locales/*.json` (all nine), `../DIVERGENCE.md` (frontend rows in the same commit)

## Interfaces

- Consumes: `api.listReasoningEfforts({ provider, model_name }) -> Promise<ReasoningEffortsResponse>` (pre-existing, `src/lib/api.ts`); `LLMSettings` (pre-existing).
- Produces (consumed by Task 6): `api.sendMessage(sid: string, content: string, opts?: { reasoningEffort?: string }) -> Promise<{ message_id, attempt_id }>`; `<ReasoningEffortSelect provider? modelName? value onChange disabled? defaultEffort />` (new component); `<ModelRuntimeBar ... reasoningEffortValue? onReasoningEffortChange? reasoningEffortDisabled? />` (extended, backward compatible — omitting the three new props keeps today's read-only badge).

---

### Step 1: Write the failing `api.ts` test

In `src/lib/__tests__/api.test.ts`, add two tests right before the existing connector-verification test. Find:

```typescript
  it("posts an authenticated connector verification request with an encoded profile id", async () => {
```

Insert immediately before it:

```typescript
  it("sends no reasoning_effort field when none is chosen", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message_id: "m1", attempt_id: "a1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await loadApiModule();
    await api.sendMessage("session", "hello");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ content: "hello" });
  });

  it("sends reasoning_effort in the body when a level is chosen", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message_id: "m1", attempt_id: "a1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await loadApiModule();
    await api.sendMessage("session", "hello", { reasoningEffort: "xhigh" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ content: "hello", reasoning_effort: "xhigh" });
  });

  it("posts an authenticated connector verification request with an encoded profile id", async () => {
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `frontend/`): `npx vitest run src/lib/__tests__/api.test.ts`
Expected: `TypeError: Cannot read properties of undefined` or a body-shape mismatch — `sendMessage` does not accept a third argument yet.

---

### Step 3: Implement the `sendMessage` option

In `src/lib/api.ts`, replace:

```typescript
  sendMessage: (sid: string, content: string) => request<{ message_id: string; attempt_id: string }>(`/sessions/${sid}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
```

with:

```typescript
  sendMessage: (sid: string, content: string, opts?: { reasoningEffort?: string }) =>
    request<{ message_id: string; attempt_id: string }>(`/sessions/${sid}/messages`, {
      method: "POST",
      body: JSON.stringify(
        opts?.reasoningEffort ? { content, reasoning_effort: opts.reasoningEffort } : { content },
      ),
    }),
```

- [ ] **Step 4: Run it, expect PASS.**

Run: `npx vitest run src/lib/__tests__/api.test.ts`
Expected: `13 passed` (11 pre-existing + 2 new).

---

### Step 5: Add the two i18n keys to all nine locale files

The locale parity test (`src/i18n/__tests__/i18n.test.ts`) requires every key in `en.json` to exist, with identical `{{variables}}`, in `zh-CN.json`, `ja.json`, `ko.json`, `ar.json`, `es.json`, `de.json`, `pt-BR.json`, and `id.json`.

- [ ] In `src/i18n/locales/en.json`, replace:

```json
    "reasoningStrength": "Reasoning Effort",
```

with:

```json
    "reasoningStrength": "Reasoning Effort",
    "reasoningEffortDefault": "Default ({{level}})",
    "reasoningEffortHint": "Applies from your next message",
```

- [ ] In `src/i18n/locales/zh-CN.json`, replace:

```json
    "reasoningStrength": "推理强度",
```

with:

```json
    "reasoningStrength": "推理强度",
    "reasoningEffortDefault": "默认（{{level}}）",
    "reasoningEffortHint": "将从下一条消息开始生效",
```

- [ ] In `src/i18n/locales/ja.json`, replace:

```json
    "reasoningStrength": "推論強度",
```

with:

```json
    "reasoningStrength": "推論強度",
    "reasoningEffortDefault": "既定（{{level}}）",
    "reasoningEffortHint": "次のメッセージから適用されます",
```

- [ ] In `src/i18n/locales/ko.json`, replace:

```json
    "reasoningStrength": "추론 강도",
```

with:

```json
    "reasoningStrength": "추론 강도",
    "reasoningEffortDefault": "기본값 ({{level}})",
    "reasoningEffortHint": "다음 메시지부터 적용됩니다",
```

- [ ] In `src/i18n/locales/ar.json`, replace:

```json
    "reasoningStrength": "جهد الاستدلال",
```

with:

```json
    "reasoningStrength": "جهد الاستدلال",
    "reasoningEffortDefault": "الافتراضي ({{level}})",
    "reasoningEffortHint": "يُطبَّق ابتداءً من رسالتك التالية",
```

- [ ] In `src/i18n/locales/es.json`, replace:

```json
    "reasoningStrength": "Esfuerzo de razonamiento",
```

with:

```json
    "reasoningStrength": "Esfuerzo de razonamiento",
    "reasoningEffortDefault": "Predeterminado ({{level}})",
    "reasoningEffortHint": "Se aplica a partir de tu próximo mensaje",
```

- [ ] In `src/i18n/locales/de.json`, replace:

```json
    "reasoningStrength": "Reasoning-Aufwand",
```

with:

```json
    "reasoningStrength": "Reasoning-Aufwand",
    "reasoningEffortDefault": "Standard ({{level}})",
    "reasoningEffortHint": "Gilt ab deiner nächsten Nachricht",
```

- [ ] In `src/i18n/locales/pt-BR.json`, replace:

```json
    "reasoningStrength": "Esforço de raciocínio",
```

with:

```json
    "reasoningStrength": "Esforço de raciocínio",
    "reasoningEffortDefault": "Padrão ({{level}})",
    "reasoningEffortHint": "Aplica-se a partir da sua próxima mensagem",
```

- [ ] In `src/i18n/locales/id.json`, replace:

```json
    "reasoningStrength": "Tingkat Reasoning",
```

with:

```json
    "reasoningStrength": "Tingkat Reasoning",
    "reasoningEffortDefault": "Default ({{level}})",
    "reasoningEffortHint": "Berlaku mulai pesan berikutnya",
```

- [ ] **Step 6: Run it, expect PASS.**

Run: `npx vitest run src/i18n/__tests__/i18n.test.ts`
Expected: `33 passed`.

---

### Step 7: Write the failing `ReasoningEffortSelect` tests

Create `src/components/chat/__tests__/ReasoningEffortSelect.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningEffortSelect } from "../ReasoningEffortSelect";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { listReasoningEfforts: vi.fn() },
}));

const listReasoningEfforts = vi.mocked(api.listReasoningEfforts);

afterEach(() => {
  vi.resetAllMocks();
});

describe("ReasoningEffortSelect", () => {
  it("lists only the levels the model's own probe accepted", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "openai",
      model_name: "o3",
      efforts: ["low", "medium", "high"],
      source: "provider",
    });

    render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="o3"
        value=""
        onChange={() => {}}
        defaultEffort="xhigh"
      />,
    );

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(screen.queryByText("Extra high")).not.toBeInTheDocument();
    expect(screen.getByText("Default (Extra high)")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("selecting a level calls onChange with that value", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "openai",
      model_name: "gpt-6.1-sol",
      efforts: ["low", "medium", "high", "xhigh"],
      source: "provider",
    });
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="gpt-6.1-sol"
        value=""
        onChange={onChange}
        defaultEffort="xhigh"
      />,
    );

    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByRole("combobox"), "low");

    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("falls back to a read-only badge when the model has no reasoning control", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "openai",
      model_name: "gpt-4.1",
      efforts: [],
      source: "provider",
    });

    render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="gpt-4.1"
        value=""
        onChange={() => {}}
        defaultEffort=""
      />,
    );

    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
    expect(screen.getByText(/Default \(Provider default\)/)).toBeInTheDocument();
  });

  it("falls back to a read-only badge when the probe request itself fails", async () => {
    listReasoningEfforts.mockRejectedValue(new Error("network error"));

    render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="gpt-6.1-sol"
        value=""
        onChange={() => {}}
        defaultEffort="xhigh"
      />,
    );

    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
    expect(screen.getByText(/Default \(Extra high\)/)).toBeInTheDocument();
  });

  it("is disabled while a run is streaming", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "openai",
      model_name: "gpt-6.1-sol",
      efforts: ["low", "medium", "high", "xhigh"],
      source: "provider",
    });

    render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="gpt-6.1-sol"
        value="high"
        onChange={() => {}}
        disabled
        defaultEffort="xhigh"
      />,
    );

    await waitFor(() => expect(screen.getByRole("combobox")).toBeDisabled());
  });

  it("stays disabled while the model's accepted levels are still loading", () => {
    listReasoningEfforts.mockImplementation(() => new Promise(() => {}));

    render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="o3"
        value="xhigh"
        onChange={() => {}}
        defaultEffort="xhigh"
      />,
    );

    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("resets a level the current model no longer accepts instead of sending it", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "openai",
      model_name: "o3",
      efforts: ["low", "medium", "high"],
      source: "provider",
    });
    const onChange = vi.fn();

    render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="o3"
        value="xhigh"
        onChange={onChange}
        defaultEffort="xhigh"
      />,
    );

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
  });

  it("does not reset a level an inconclusive probe cannot confirm or deny", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "custom",
      model_name: "m",
      efforts: ["low", "medium", "high"],
      source: "default",
    });
    const onChange = vi.fn();

    render(
      <ReasoningEffortSelect
        provider="custom"
        modelName="m"
        value="xhigh"
        onChange={onChange}
        defaultEffort="xhigh"
      />,
    );

    await waitFor(() => expect(listReasoningEfforts).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("re-fetches when the model changes", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "openai",
      model_name: "gpt-5.5",
      efforts: ["none", "low", "medium", "high", "xhigh"],
      source: "provider",
    });

    const { rerender } = render(
      <ReasoningEffortSelect
        provider="openai"
        modelName="gpt-6.1-sol"
        value=""
        onChange={() => {}}
        defaultEffort="xhigh"
      />,
    );
    await waitFor(() => expect(listReasoningEfforts).toHaveBeenCalledTimes(1));

    rerender(
      <ReasoningEffortSelect
        provider="openai"
        modelName="gpt-5.5"
        value=""
        onChange={() => {}}
        defaultEffort="xhigh"
      />,
    );

    await waitFor(() => expect(listReasoningEfforts).toHaveBeenCalledTimes(2));
    expect(listReasoningEfforts).toHaveBeenLastCalledWith({ provider: "openai", model_name: "gpt-5.5" });
  });
});
```

- [ ] **Step 8: Run it and watch it fail.**

Run: `npx vitest run src/components/chat/__tests__/ReasoningEffortSelect.test.tsx`
Expected: `Failed to resolve import "../ReasoningEffortSelect"`.

---

### Step 9: Implement `ReasoningEffortSelect`

Create `src/components/chat/ReasoningEffortSelect.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ReasoningEffortsResponse } from "@/lib/api";

interface Props {
  /** The provider/model about to receive the next message. */
  provider?: string;
  modelName?: string;
  /** "" means Default (no override); otherwise one of LLM_REASONING_EFFORT_ORDER. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The server default shown in the "Default (…)" option, e.g. settings.reasoning_effort. */
  defaultEffort: string;
}

const EFFORT_LABEL_KEYS: Record<string, string> = {
  none: "settings.reasoningEffortNone",
  minimal: "settings.reasoningEffortMinimal",
  low: "settings.reasoningEffortLow",
  medium: "settings.reasoningEffortMedium",
  high: "settings.reasoningEffortHigh",
  xhigh: "settings.reasoningEffortXhigh",
  max: "settings.reasoningEffortMax",
};

/** Native <select> for the chat bar's per-message reasoning effort override.
 *
 * Options come from the model's own accepted list (``api.listReasoningEfforts``).
 * When the probe confirms the model has no reasoning control at all, or the
 * probe request itself fails, this renders the read-only badge instead (the
 * same fallback ``ModelRuntimeBar`` used before the selector existed).
 */
export function ReasoningEffortSelect({ provider, modelName, value, onChange, disabled, defaultEffort }: Props) {
  const { t } = useTranslation();
  const [result, setResult] = useState<ReasoningEffortsResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Read inside the fetch callback instead of as effect deps: the probe only
  // needs the *current* value/onChange when it resolves, and listing them as
  // deps would re-fetch on every keystroke-level onChange identity change.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setResult(null);
    setUnavailable(false);
    if (!provider || !modelName) return;
    let alive = true;
    api.listReasoningEfforts({ provider, model_name: modelName })
      .then((response) => {
        if (!alive) return;
        setResult(response);
        if (response.source === "provider" && response.efforts.length === 0) {
          setUnavailable(true);
        }
        // A reloaded chat (or a model switched in Settings) may carry a level
        // the current model no longer accepts: reset to Default rather than
        // silently sending a value the picker no longer offers as an option.
        if (
          response.source === "provider"
          && valueRef.current
          && !response.efforts.includes(valueRef.current)
        ) {
          onChangeRef.current("");
        }
      })
      .catch(() => {
        if (!alive) return;
        setUnavailable(true);
      });
    return () => {
      alive = false;
    };
  }, [provider, modelName]);

  const effortLabel = (effort: string): string => {
    if (!effort) return t("settings.providerDefault");
    const key = EFFORT_LABEL_KEYS[effort];
    return key ? t(key as never) : effort;
  };
  const defaultLabel = t("agent.reasoningEffortDefault", { level: effortLabel(defaultEffort) });

  if (unavailable) {
    return (
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/35 px-2 py-0.5 text-[10px] text-muted-foreground">
        {t("agent.reasoningStrength")}: {defaultLabel}
      </span>
    );
  }

  const efforts = result?.efforts ?? [];

  return (
    <select
      aria-label={t("agent.reasoningStrength")}
      title={t("agent.reasoningEffortHint")}
      value={value}
      disabled={disabled || !result}
      onChange={(event) => onChange(event.target.value)}
      className="ml-auto shrink-0 rounded-full border border-border/70 bg-muted/35 px-2 py-0.5 text-[10px] text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-70"
    >
      <option value="">{defaultLabel}</option>
      {efforts.map((effort) => (
        <option key={effort} value={effort}>{effortLabel(effort)}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 10: Run it, expect PASS.**

Run: `npx vitest run src/components/chat/__tests__/ReasoningEffortSelect.test.tsx`
Expected: `9 passed`.

---

### Step 11: Write the failing `ModelRuntimeBar` integration tests

In `src/components/chat/__tests__/ModelRuntimeBar.test.tsx`, replace the full header (imports through the `settings` constant are unaffected; only the import block and the `describe` opening change):

Replace:

```tsx
import { render, screen } from "@testing-library/react";
import { ModelRuntimeBar } from "../ModelRuntimeBar";
import type { LLMSettings } from "@/lib/api";
```

with:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { ModelRuntimeBar } from "../ModelRuntimeBar";
import { api, type LLMSettings } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { ...actual.api, listReasoningEfforts: vi.fn() } };
});

const listReasoningEfforts = vi.mocked(api.listReasoningEfforts);
```

Replace:

```tsx
describe("ModelRuntimeBar", () => {
  it("shows provider, provider-reported model and configured reasoning effort", () => {
```

with:

```tsx
describe("ModelRuntimeBar", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("shows provider, provider-reported model and configured reasoning effort", () => {
```

Then append two new tests right before the file's closing `});`:

```tsx

  it("renders the selector instead of the badge once a change handler is given", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "deepseek",
      model_name: "deepseek-v4-flash",
      efforts: ["low", "medium", "high"],
      source: "provider",
    });

    render(
      <ModelRuntimeBar
        settings={settings}
        reasoningEffortValue=""
        onReasoningEffortChange={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    expect(screen.queryByText(/^Reasoning Effort: /)).not.toBeInTheDocument();
  });

  it("disables the selector while a run is streaming", async () => {
    listReasoningEfforts.mockResolvedValue({
      provider: "deepseek",
      model_name: "deepseek-v4-flash",
      efforts: ["low", "medium", "high"],
      source: "provider",
    });

    render(
      <ModelRuntimeBar
        settings={settings}
        reasoningEffortValue="high"
        onReasoningEffortChange={() => {}}
        reasoningEffortDisabled
      />,
    );

    await waitFor(() => expect(screen.getByRole("combobox")).toBeDisabled());
  });
```

(i.e. the new tests land just before the file's final `});` that closes the top-level `describe` block.)

- [ ] **Step 12: Run it and watch it fail.**

Run: `npx vitest run src/components/chat/__tests__/ModelRuntimeBar.test.tsx`
Expected: the two new tests fail (`Unable to find role="combobox"` — `ModelRuntimeBar` still renders the badge unconditionally).

---

### Step 13: Implement the `ModelRuntimeBar` change

Replace the full contents of `src/components/chat/ModelRuntimeBar.tsx`:

```tsx
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LLMSettings } from "@/lib/api";
import { ReasoningEffortSelect } from "./ReasoningEffortSelect";

interface Props {
  settings: LLMSettings | null;
  runtimeProvider?: string;
  runtimeModel?: string;
  runtimeReasoningEffort?: string;
  /** Current chat-bar choice ("" = Default); ignored while streaming. */
  reasoningEffortValue?: string;
  onReasoningEffortChange?: (value: string) => void;
  reasoningEffortDisabled?: boolean;
}

export function ModelRuntimeBar({
  settings,
  runtimeProvider,
  runtimeModel,
  runtimeReasoningEffort,
  reasoningEffortValue,
  onReasoningEffortChange,
  reasoningEffortDisabled,
}: Props) {
  const { t } = useTranslation();
  if (!settings) return null;

  const providerId = runtimeProvider || settings.provider;
  const provider = settings.providers.find((item) => item.name === providerId);
  const providerLabel = provider?.label || providerId || t("agent.unknownProvider");
  const model = runtimeModel || settings.model_name || t("agent.unknownModel");

  return (
    <div className="shrink-0 border-b border-border/70 bg-background/95 px-6 py-2 backdrop-blur-sm">
      <div className="mx-auto flex max-w-3xl items-center gap-2 overflow-hidden text-xs">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-success/30" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </span>
        <span className="shrink-0 font-medium text-foreground">{providerLabel}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={model}>{model}</span>
        {onReasoningEffortChange ? (
          <ReasoningEffortSelect
            provider={settings.provider}
            modelName={settings.model_name}
            value={reasoningEffortValue ?? ""}
            onChange={onReasoningEffortChange}
            disabled={reasoningEffortDisabled}
            defaultEffort={settings.reasoning_effort}
          />
        ) : (
          <ReasoningBadge
            effort={runtimeReasoningEffort !== undefined ? runtimeReasoningEffort : settings.reasoning_effort}
          />
        )}
      </div>
    </div>
  );
}

/** Read-only fallback badge, kept for callers that pass no change handler. */
function ReasoningBadge({ effort }: { effort: string }) {
  const { t } = useTranslation();
  const effortLabels: Record<string, string> = {
    none: t("settings.reasoningEffortNone"),
    minimal: t("settings.reasoningEffortMinimal"),
    low: t("settings.reasoningEffortLow"),
    medium: t("settings.reasoningEffortMedium"),
    high: t("settings.reasoningEffortHigh"),
    xhigh: t("settings.reasoningEffortXhigh"),
    max: t("settings.reasoningEffortMax"),
  };
  const effortLabel = effortLabels[effort] || t("settings.providerDefault");
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/35 px-2 py-0.5 text-[10px] text-muted-foreground">
      <Cpu className="h-3 w-3" aria-hidden="true" />
      {t("agent.reasoningStrength")}: {effortLabel}
    </span>
  );
}
```

- [ ] **Step 14: Run it, expect PASS.**

Run: `npx vitest run src/components/chat/__tests__/ModelRuntimeBar.test.tsx`
Expected: `5 passed`.

---

### Step 15: Fix two existing `Agent.tsx` integration tests whose `api` mock now needs `listReasoningEfforts`

`ModelRuntimeBar` without a change handler never calls the probe, so most existing tests are unaffected. Two render a full `<Agent />` page (which Task 6 wires with a change handler), so they need the function to exist on their `apiMock` even before Task 6 lands, because a shared mock object without the key throws `TypeError: api.listReasoningEfforts is not a function` the moment any later-mounted test in the same file tree exercises it. Apply this now so Task 6 inherits a clean baseline.

- [ ] In `src/pages/__tests__/AgentGroundingStatus.test.tsx`, replace:

```tsx
const apiMock = vi.hoisted(() => ({
  getGoal: vi.fn(),
  getLLMSettings: vi.fn(),
  getRun: vi.fn(),
  getSessionMessages: vi.fn(),
  sseUrl: vi.fn((sid: string) => `/sessions/${sid}/events`),
}));
```

with:

```tsx
const apiMock = vi.hoisted(() => ({
  getGoal: vi.fn(),
  getLLMSettings: vi.fn(),
  getRun: vi.fn(),
  getSessionMessages: vi.fn(),
  listReasoningEfforts: vi.fn(),
  sseUrl: vi.fn((sid: string) => `/sessions/${sid}/events`),
}));
```

and replace:

```tsx
    apiMock.getGoal.mockResolvedValue(null);
    apiMock.getRun.mockResolvedValue({});
    apiMock.getSessionMessages.mockResolvedValue([]);
    apiMock.getLLMSettings.mockResolvedValue({
```

with:

```tsx
    apiMock.getGoal.mockResolvedValue(null);
    apiMock.getRun.mockResolvedValue({});
    apiMock.getSessionMessages.mockResolvedValue([]);
    apiMock.listReasoningEfforts.mockResolvedValue({
      provider: "deepseek", model_name: "deepseek-v4-pro", efforts: ["low", "medium", "high"], source: "provider",
    });
    apiMock.getLLMSettings.mockResolvedValue({
```

- [ ] In `src/pages/__tests__/AgentBackgroundStreamCompletion.test.tsx`, replace:

```tsx
const apiMock = vi.hoisted(() => ({
  getGoal: vi.fn(),
  getLLMSettings: vi.fn(),
  getRun: vi.fn(),
  getSessionMessages: vi.fn(),
  sseUrl: vi.fn((sid: string) => `/sessions/${sid}/events`),
}));
```

with:

```tsx
const apiMock = vi.hoisted(() => ({
  getGoal: vi.fn(),
  getLLMSettings: vi.fn(),
  getRun: vi.fn(),
  getSessionMessages: vi.fn(),
  listReasoningEfforts: vi.fn(),
  sseUrl: vi.fn((sid: string) => `/sessions/${sid}/events`),
}));
```

and replace:

```tsx
    useAgentStore.getState().reset();
    apiMock.getGoal.mockResolvedValue(null);
    apiMock.getLLMSettings.mockResolvedValue({
```

with:

```tsx
    useAgentStore.getState().reset();
    apiMock.getGoal.mockResolvedValue(null);
    apiMock.listReasoningEfforts.mockResolvedValue({
      provider: "deepseek", model_name: "deepseek-v4-pro", efforts: ["low", "medium", "high"], source: "provider",
    });
    apiMock.getLLMSettings.mockResolvedValue({
```

- [ ] **Step 16: Run the whole frontend suite, expect PASS.**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: `tsc -b` clean; `78 files / 760 passed` at this task boundary (the later Task 6 adds one file with five tests); the build succeeds (one pre-existing "chunks larger than 500 kB" warning is expected and unrelated — `vendor-charts` already exceeded it before this change).

---

### Step 17: Update `packages/vibe-trading/DIVERGENCE.md`

Find the last row of the **frontend** changes table:

```
| `pages/__tests__/SettingsChannels.test.tsx`, `SettingsQVeris.test.tsx` | Mocks updated; the QVeris test now asserts the card is absent. | |
```

Replace it with itself plus four new rows directly after:

```
| `pages/__tests__/SettingsChannels.test.tsx`, `SettingsQVeris.test.tsx` | Mocks updated; the QVeris test now asserts the card is absent. | |
| `lib/api.ts` | `sendMessage(sid, content, opts?: { reasoningEffort? })` includes `reasoning_effort` in the body only when set. | Per-message effort in the chat (01p). |
| `components/chat/ModelRuntimeBar.tsx`, new `ReasoningEffortSelect.tsx` | The read-only effort badge is replaced by a native `<select>` when a change handler is given; the badge remains the fallback for a model with no reasoning control or a failed probe. | Owner request: effort changeable from the chat, not only Settings. |
| `i18n/locales/*.json` (9 files) | Adds `agent.reasoningEffortDefault` (`{{level}}` placeholder), `agent.reasoningEffortHint`. | The locale parity test. |
| `lib/__tests__/api.test.ts`, `components/chat/__tests__/ModelRuntimeBar.test.tsx`, new `ReasoningEffortSelect.test.tsx`, `pages/__tests__/AgentGroundingStatus.test.tsx`, `AgentBackgroundStreamCompletion.test.tsx` | Extended / mocks updated. | |
```

- [ ] **Step 18: Commit.**

```
git -C ai-trading/packages/vibe-trading add frontend/src/lib/api.ts frontend/src/lib/__tests__/api.test.ts frontend/src/components/chat/ReasoningEffortSelect.tsx frontend/src/components/chat/__tests__/ReasoningEffortSelect.test.tsx frontend/src/components/chat/ModelRuntimeBar.tsx frontend/src/components/chat/__tests__/ModelRuntimeBar.test.tsx frontend/src/i18n/locales/*.json frontend/src/pages/__tests__/AgentGroundingStatus.test.tsx frontend/src/pages/__tests__/AgentBackgroundStreamCompletion.test.tsx DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): replace the read-only reasoning-effort badge with a chat-bar selector"
```
