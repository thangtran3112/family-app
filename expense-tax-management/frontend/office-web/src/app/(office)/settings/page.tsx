"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { PageHead, Panel, Status } from "@/components/ui";
import { fetchTags, createTag, updateTag, archiveTag, unarchiveTag, mergeTags, makeStableIdempotencyKey } from "@/lib/api";
import { readOfficeSession } from "@/lib/session";

type Tag = {
  id: string;
  key: string;
  name: string;
  color: string | null;
  status: "active" | "archived";
  version: number;
  origin: string;
};

type TenantRole = "owner" | "admin" | "member";

function canManageTags(role: TenantRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

function TagRow({
  tag,
  canManage,
  onRename,
  onArchive,
  onUnarchive,
  onMergeSource,
  mergeSourceId,
  onMergeTarget,
  disabled,
}: {
  tag: Tag;
  canManage: boolean;
  onRename: (tag: Tag, newName: string) => void;
  onArchive: (tag: Tag) => void;
  onUnarchive: (tag: Tag) => void;
  onMergeSource: (id: string) => void;
  mergeSourceId: string | null;
  onMergeTarget: (tag: Tag) => void;
  disabled: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(tag.name);

  function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (nameInput.trim() && nameInput.trim() !== tag.name) {
      onRename(tag, nameInput.trim());
    }
    setRenaming(false);
  }

  const isArchived = tag.status === "archived";
  const isMergeSource = mergeSourceId === tag.id;

  return (
    <tr>
      <td>
        <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: tag.color ?? "#aab2ad", marginRight: 6 }} aria-hidden="true" />
        {tag.key}
      </td>
      <td>
        {renaming && canManage ? (
          <form onSubmit={submitRename} aria-label={`Rename tag ${tag.name}`}>
            <label htmlFor={`rename-${tag.id}`} className="sr-only">New name for {tag.name}</label>
            <input
              id={`rename-${tag.id}`}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              autoFocus
              required
              aria-required="true"
            />
            <button type="submit" disabled={disabled}>Save</button>
            <button type="button" onClick={() => { setRenaming(false); setNameInput(tag.name); }}>Cancel</button>
          </form>
        ) : (
          tag.name
        )}
      </td>
      <td><Status tone={isArchived ? "warn" : "ok"}>{tag.status}</Status></td>
      <td>{tag.origin}</td>
      <td>v{tag.version}</td>
      <td>
        {canManage && !isArchived && (
          <div className="toolbar" role="group" aria-label={`Actions for ${tag.name}`}>
            <button type="button" onClick={() => setRenaming(true)} disabled={disabled || renaming} aria-label={`Rename ${tag.name}`}>Rename</button>
            <button type="button" onClick={() => onArchive(tag)} disabled={disabled} aria-label={`Archive ${tag.name}`} className="danger">Archive</button>
            <button
              type="button"
              onClick={() => {
                if (mergeSourceId && mergeSourceId !== tag.id) onMergeTarget(tag);
                else onMergeSource(tag.id);
              }}
              disabled={disabled}
              aria-label={mergeSourceId && mergeSourceId !== tag.id ? `Merge ${mergeSourceId} into ${tag.name}` : `Select ${tag.name} as merge source`}
              aria-pressed={isMergeSource}
            >
              {isMergeSource ? "Cancel merge" : mergeSourceId && mergeSourceId !== tag.id ? "Merge here" : "Start merge"}
            </button>
          </div>
        )}
        {canManage && isArchived && (
          <button type="button" onClick={() => onUnarchive(tag)} disabled={disabled} aria-label={`Unarchive ${tag.name}`}>Unarchive</button>
        )}
        {!canManage && <span className="muted">Read only</span>}
      </td>
    </tr>
  );
}

export default function Settings() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();

  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("");
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);

  // Tenant role — would come from membership API; placeholder from org membership
  const tenantRole: TenantRole = "owner"; // owner for demonstration; real impl reads from API

  const createIdemKey = useRef(makeStableIdempotencyKey("create-tag", newTagName));

  const session = isLoaded && isSignedIn ? readOfficeSession() : null;

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !organization || !session) return;
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        const data = await fetchTags(session, getToken, organization.id);
        if (active) setTags(data.items as Tag[]);
      } catch (e: unknown) {
        if (active) setError(e instanceof Error ? e.message : "Tags unavailable");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [getToken, isLoaded, isSignedIn, organization, organizationLoaded, session]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !organization || !newTagName.trim()) return;
    setSaving(true);
    setError(null);
    createIdemKey.current = makeStableIdempotencyKey("create-tag", newTagName.trim(), Date.now().toString());
    try {
      const tag = await createTag(session, newTagName.trim(), newTagColor.trim() || null, createIdemKey.current, getToken, organization.id);
      setTags((prev) => [...prev, tag as Tag]);
      setNewTagName("");
      setNewTagColor("");
      setSuccessMsg(`Tag "${(tag as Tag).name}" created.`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("conflict")) { setConflictMsg(e.message); }
      else setError(e instanceof Error ? e.message : "Tag creation failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleRename(tag: Tag, newName: string) {
    if (!session || !organization) return;
    setSaving(true);
    setError(null);
    const idemKey = makeStableIdempotencyKey("rename-tag", tag.id, String(tag.version));
    try {
      const updated = await updateTag(session, tag.id, { expectedVersion: tag.version, name: newName }, idemKey, getToken, organization.id);
      setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, ...(updated as Partial<Tag>) } : t));
      setSuccessMsg(`Tag renamed to "${newName}".`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("conflict")) { setConflictMsg(e.message); }
      else setError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(tag: Tag) {
    if (!session || !organization) return;
    setSaving(true);
    setError(null);
    const idemKey = makeStableIdempotencyKey("archive-tag", tag.id, String(tag.version));
    try {
      await archiveTag(session, tag.id, tag.version, idemKey, getToken, organization.id);
      setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, status: "archived" as const, version: t.version + 1 } : t));
      setSuccessMsg(`Tag "${tag.name}" archived.`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("conflict")) { setConflictMsg(e.message); }
      else setError(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleUnarchive(tag: Tag) {
    if (!session || !organization) return;
    setSaving(true);
    setError(null);
    const idemKey = makeStableIdempotencyKey("unarchive-tag", tag.id, String(tag.version));
    try {
      await unarchiveTag(session, tag.id, tag.version, idemKey, getToken, organization.id);
      setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, status: "active" as const, version: t.version + 1 } : t));
      setSuccessMsg(`Tag "${tag.name}" unarchived.`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("conflict")) { setConflictMsg(e.message); }
      else setError(e instanceof Error ? e.message : "Unarchive failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleMergeTarget(targetTag: Tag) {
    if (!session || !organization || !mergeSourceId) return;
    const sourceTag = tags.find((t) => t.id === mergeSourceId);
    if (!sourceTag) return;
    setSaving(true);
    setError(null);
    const idemKey = makeStableIdempotencyKey("merge-tag", sourceTag.id, targetTag.id, String(sourceTag.version), String(targetTag.version));
    try {
      await mergeTags(session, sourceTag.id, targetTag.id, sourceTag.version, targetTag.version, idemKey, getToken, organization.id);
      setTags((prev) => prev.filter((t) => t.id !== sourceTag.id));
      setMergeSourceId(null);
      setSuccessMsg(`Tag "${sourceTag.name}" merged into "${targetTag.name}".`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("conflict")) { setConflictMsg(e.message); }
      else setError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setSaving(false);
    }
  }

  function handleConflictRefresh() {
    if (!session || !organization) return;
    setConflictMsg(null);
    setLoading(true);
    void fetchTags(session, getToken, organization.id)
      .then((data) => setTags(data.items as Tag[]))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Refresh failed"))
      .finally(() => setLoading(false));
  }

  const isPersonal = session?.scope.kind === "personal";

  return (
    <>
      <PageHead eyebrow="Tenant settings" title="Administration without provider controls." />

      {/* Tag management - available for both Personal and Business scope */}
      <Panel title="Tag management">
        {loading && <div role="status" aria-live="polite" className="empty">Loading tags...</div>}
        {error && <div role="alert" className="empty">{error}</div>}
        {conflictMsg && (
          <div role="alert" className="empty warn-note">
            {conflictMsg}
            <button type="button" onClick={handleConflictRefresh} disabled={loading}>Refresh to resolve</button>
          </div>
        )}
        {successMsg && <div role="status" aria-live="polite" className="empty">{successMsg}</div>}

        {canManageTags(tenantRole) && (
          <form onSubmit={handleCreate} aria-label="Create new tag" className="create-form">
            <h3>Create tag</h3>
            <div className="field-row">
              <label htmlFor="new-tag-name">Tag name</label>
              <input
                id="new-tag-name"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="e.g. Travel"
                required
                aria-required="true"
                disabled={saving}
              />
            </div>
            <div className="field-row">
              <label htmlFor="new-tag-color">Color (optional hex)</label>
              <input
                id="new-tag-color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                placeholder="#RRGGBB"
                pattern="^#[0-9A-Fa-f]{6}$"
                disabled={saving}
              />
            </div>
            <button type="submit" className="primary" disabled={saving || !newTagName.trim()} aria-busy={saving}>
              {saving ? "Creating..." : "Create tag"}
            </button>
          </form>
        )}
        {!canManageTags(tenantRole) && (
          <p className="muted">Tag management requires owner or admin role.</p>
        )}

        {mergeSourceId && (
          <div role="status" aria-live="polite" className="empty warn-note">
            Merge in progress: select a target tag row to complete the merge, or Cancel merge on the source row.
          </div>
        )}

        {tags.length > 0 ? (
          <table aria-label="Tenant tags">
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th>Status</th>
                <th>Origin</th>
                <th>Version</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  canManage={canManageTags(tenantRole)}
                  onRename={handleRename}
                  onArchive={handleArchive}
                  onUnarchive={handleUnarchive}
                  onMergeSource={(id) => setMergeSourceId((prev) => prev === id ? null : id)}
                  mergeSourceId={mergeSourceId}
                  onMergeTarget={handleMergeTarget}
                  disabled={saving || loading}
                />
              ))}
            </tbody>
          </table>
        ) : (
          !loading && <div className="empty">No tags yet. Create the first tag above.</div>
        )}
      </Panel>

      <div className="two">
        <Panel title="Members">
          <p>Owner · Admin · Member at tenant level. Profile access remains separate.</p>
          <button type="button">Invite member</button>
        </Panel>
        <Panel title="Plan + add-ons">
          <p>Trial · AI search 20/month · receipt forwarding enabled.</p>
          <button type="button">Manage subscription</button>
        </Panel>
      </div>

      {/* Business-only features - show accessible unavailable state for Personal scope */}
      {isPersonal ? (
        <Panel title="Business features">
          <div className="empty" role="status" aria-label="Business features unavailable in Personal scope">
            <p>Businesses, projects, tax profiles, and exports are available in Business scope only.</p>
            <p>Switch to a Business scope to access these features.</p>
          </div>
        </Panel>
      ) : (
        <Panel title="Forbidden here">
          <p>Provider credentials, raw model IDs, route versions, arbitrary prompts, health telemetry, and quota overrides belong only to Foundry.</p>
        </Panel>
      )}
    </>
  );
}
