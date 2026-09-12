import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import Modal from "./Modal.jsx";
import {
  fetchCoachingPrograms,
  fetchWorkspaceMedia,
  updateProgramPublicPresentation,
  uploadEventImage,
  uploadProgramVideo,
} from "../services/api.js";

export default function ProgramWebsiteSettings({ websiteUrl = "/", onChange }) {
  const [programs, setPrograms] = useState([]),
    [editing, setEditing] = useState(null),
    [draggingId, setDraggingId] = useState(""),
    [media, setMedia] = useState([]),
    [showLibrary, setShowLibrary] = useState(false),
    [saving, setSaving] = useState(false),
    [orderDirty, setOrderDirty] = useState(false),
    [newComparisonFeature, setNewComparisonFeature] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const sectionOf = (program) =>
    program.publicPresentation?.section ||
    (Number(program.defaultPrice?.amount || 0) >= 10000
      ? "accelerator"
      : "intensive");
  const orderedPrograms = [...programs].sort((a, b) => {
    const sectionDifference =
      (sectionOf(a) === "accelerator" ? 0 : 1) -
      (sectionOf(b) === "accelerator" ? 0 : 1);
    return (
      sectionDifference ||
      Number(a.publicPresentation?.sortOrder || 0) -
        Number(b.publicPresentation?.sortOrder || 0) ||
      String(a.name || "").localeCompare(String(b.name || ""))
    );
  });
  const comparisonPrograms = orderedPrograms.filter(
    (program) =>
      program.status === "active" &&
      program.publicPresentation?.status === "published" &&
      sectionOf(program) === "accelerator",
  );
  const comparisonFeatures = [
    ...new Set(
      comparisonPrograms.flatMap(
        (program) => program.publicPresentation?.highlights || [],
      ),
    ),
  ];
  const presentationForEditing = (program) => {
    const current = program.publicPresentation || {};
    const description = current.description || current.summary || program.internalSummary || "";
    return {
      ...program,
      publicPresentation: {
        ...current,
        title: current.title || program.name,
        description,
        summary: description,
        priceVisible: true,
      },
    };
  };
  const load = () =>
    fetchCoachingPrograms({ limit: 200 })
      .then(setPrograms)
      .catch((err) =>
        setError(
          err.response?.data?.error ||
            "Unable to load program website settings.",
        ),
      );
  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const patch = (key, value) =>
    setEditing((row) => ({
      ...row,
      publicPresentation: { ...row.publicPresentation, [key]: value },
    }));
  const patchComparison = (programId, key, value) =>
    setPrograms((rows) =>
      rows.map((row) =>
        row._id === programId
          ? {
              ...row,
              publicPresentation: {
                ...(row.publicPresentation || {}),
                [key]: value,
              },
            }
          : row,
      ),
    );
  const comparisonValue = (program, key, index) => {
    const presentation = program.publicPresentation || {};
    if (key === "tierLabel") {
      if (presentation.tierLabel) return presentation.tierLabel;
      const amount = Number(program.defaultPrice?.amount || 0);
      if (amount >= 20000) return "ALL-INCLUSIVE";
      if (amount >= 15000) return "ACQUIRE";
      if (amount >= 10000) return "IMPLEMENT";
      return ["IMPLEMENT", "ACQUIRE", "ALL-INCLUSIVE"][index] || "PROGRAM";
    }
    if (key === "comparisonPriceLabel") {
      if (presentation.comparisonPriceLabel)
        return presentation.comparisonPriceLabel;
      return program.defaultPrice?.amount != null
        ? new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: program.defaultPrice.currency || "USD",
            maximumFractionDigits: 0,
          }).format(program.defaultPrice.amount)
        : "Talk with our team";
    }
    if (key === "comparisonDurationLabel") {
      if (presentation.comparisonDurationLabel)
        return presentation.comparisonDurationLabel;
      return program.duration?.value
        ? `${program.duration.value} ${program.duration.unit || ""}`.trim()
        : "Ask our team";
    }
    if (key === "coachingFormat") {
      if (presentation.coachingFormat) return presentation.coachingFormat;
      const text = `${program.deliveryMode || ""} ${presentation.title || program.name || ""}`;
      if (/one[- ]on[- ]one|1[- ]on[- ]1/i.test(text)) return "ONE-ON-ONE";
      if (/bootcamp/i.test(text)) return "BOOTCAMP";
      return "COACHING";
    }
    return presentation[key] || "";
  };
  const saveComparisonTable = async () => {
    try {
      setSaving(true);
      const savedRows = await Promise.all(
        comparisonPrograms.map((program, index) =>
          updateProgramPublicPresentation(program._id, {
            ...(program.publicPresentation || {}),
            tierLabel: comparisonValue(program, "tierLabel", index),
            comparisonPriceLabel: comparisonValue(
              program,
              "comparisonPriceLabel",
              index,
            ),
            comparisonDurationLabel: comparisonValue(
              program,
              "comparisonDurationLabel",
              index,
            ),
            coachingFormat: comparisonValue(program, "coachingFormat", index),
          }),
        ),
      );
      const savedById = new Map(savedRows.map((row) => [row._id, row]));
      setPrograms((rows) => rows.map((row) => savedById.get(row._id) || row));
      setMessage("The complete website comparison table was saved.");
      setError("");
      onChange?.();
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to save comparison table settings.",
      );
    } finally {
      setSaving(false);
    }
  };
  const renameComparisonFeature = (currentFeature, nextFeature) => {
    const normalizedFeature = nextFeature.trim();
    const comparisonIds = new Set(comparisonPrograms.map((row) => row._id));
    setPrograms((rows) =>
      rows.map((program) =>
        comparisonIds.has(program._id)
          ? {
              ...program,
              publicPresentation: {
                ...(program.publicPresentation || {}),
                highlights: [
                  ...new Set(
                    (program.publicPresentation?.highlights || []).flatMap(
                      (feature) =>
                        feature === currentFeature
                          ? normalizedFeature
                            ? [normalizedFeature]
                            : []
                          : [feature],
                    ),
                  ),
                ],
              },
            }
          : program,
      ),
    );
  };
  const toggleComparisonFeature = (programId, feature, included) => {
    const program = programs.find((row) => row._id === programId);
    const highlights = program?.publicPresentation?.highlights || [];
    patchComparison(
      programId,
      "highlights",
      included
        ? [...new Set([...highlights, feature])]
        : highlights.filter((item) => item !== feature),
    );
  };
  const addComparisonFeature = () => {
    const feature = newComparisonFeature.trim();
    if (!feature || comparisonFeatures.includes(feature)) return;
    setPrograms((rows) =>
      rows.map((program) =>
        comparisonPrograms.some((item) => item._id === program._id)
          ? {
              ...program,
              publicPresentation: {
                ...(program.publicPresentation || {}),
                highlights: [
                  ...(program.publicPresentation?.highlights || []),
                  feature,
                ],
              },
            }
          : program,
      ),
    );
    setNewComparisonFeature("");
  };
  const persistProgramImage = async (imageUrl) => {
    const saved = await updateProgramPublicPresentation(editing._id, {
      ...(editing.publicPresentation || {}),
      imageUrl,
      summary: editing.publicPresentation?.description || "",
      priceVisible: true,
    });
    setPrograms((rows) =>
      rows.map((row) => (row._id === saved._id ? saved : row)),
    );
    setEditing(presentationForEditing(saved));
    setMessage(
      imageUrl
        ? `${saved.name} image saved to the public website.`
        : `${saved.name} image removed from the public website.`,
    );
    setError("");
    onChange?.();
  };
  const save = async () => {
    try {
      setSaving(true);
      const saved = await updateProgramPublicPresentation(
        editing._id,
        {
          ...(editing.publicPresentation || {}),
          summary: editing.publicPresentation?.description || "",
          priceVisible: true,
        },
      );
      if (saved.publicPresentation?.featured) {
        const others = programs.filter(
          (row) =>
            row._id !== saved._id &&
            row.publicPresentation?.featured &&
            sectionOf(row) === sectionOf(saved),
        );
        const unfeatured = await Promise.all(
          others.map((row) =>
            updateProgramPublicPresentation(row._id, {
              ...(row.publicPresentation || {}),
              featured: false,
            }),
          ),
        );
        const unfeaturedById = new Map(
          unfeatured.map((row) => [row._id, row]),
        );
        setPrograms((rows) =>
          rows.map((row) => unfeaturedById.get(row._id) || row),
        );
      }
      setPrograms((rows) =>
        rows.map((row) => (row._id === saved._id ? saved : row)),
      );
      setEditing(null);
      setMessage(`${saved.name} website presentation saved.`);
      setError("");
      onChange?.();
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to save program website settings.",
      );
    } finally {
      setSaving(false);
    }
  };
  const setVisibility = async (program, visible) => {
    try {
      setSaving(true);
      const saved = await updateProgramPublicPresentation(program._id, {
        ...program.publicPresentation,
        status: visible ? "published" : "hidden",
      });
      setPrograms((rows) =>
        rows.map((row) => (row._id === saved._id ? saved : row)),
      );
      onChange?.();
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to update program visibility.",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveOrder = async () => {
    const nextOrder = ["accelerator", "intensive"].flatMap((section) =>
      orderedPrograms
        .filter((program) => sectionOf(program) === section)
        .map((program, index) => {
          const hydrated = presentationForEditing(program);
          return {
            ...program,
            publicPresentation: {
              ...hydrated.publicPresentation,
              section,
              sortOrder: (index + 1) * 10,
            },
          };
        }),
    );
    try {
      setSaving(true);
      const savedRows = await Promise.all(
        nextOrder.map((program) =>
          updateProgramPublicPresentation(
            program._id,
            program.publicPresentation,
          ),
        ),
      );
      const savedById = new Map(savedRows.map((program) => [program._id, program]));
      setPrograms((rows) => rows.map((row) => savedById.get(row._id) || row));
      setMessage("Program order saved. The public website will use this order.");
      setError("");
      setOrderDirty(false);
      onChange?.();
    } catch (err) {
      await load();
      setError(err.response?.data?.error || "Unable to save program order.");
    } finally {
      setSaving(false);
      setDraggingId("");
    }
  };
  const moveProgram = (programId, targetId) => {
    const program = programs.find((row) => row._id === programId);
    const target = programs.find((row) => row._id === targetId);
    if (!program || !target || programId === targetId) return;
    const section = sectionOf(program);
    if (sectionOf(target) !== section) return;
    const rows = orderedPrograms.filter((row) => sectionOf(row) === section);
    const from = rows.findIndex((row) => row._id === programId);
    const to = rows.findIndex((row) => row._id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    const nextById = new Map(
      rows.map((row, index) => [
        row._id,
        {
          ...row,
          publicPresentation: {
            ...(row.publicPresentation || {}),
            section,
            sortOrder: (index + 1) * 10,
          },
        },
      ]),
    );
    setPrograms((current) =>
      current.map((row) => nextById.get(row._id) || row),
    );
    setOrderDirty(true);
    setMessage("");
    setError("");
    setDraggingId("");
  };
  const nudgeProgram = (program, direction) => {
    const section = sectionOf(program);
    const rows = orderedPrograms.filter((row) => sectionOf(row) === section);
    const index = rows.findIndex((row) => row._id === program._id);
    const target = rows[index + direction];
    if (target) moveProgram(program._id, target._id);
  };
  const chooseMedia = async (type = "video") => {
    try {
      const contentAssets = await fetchWorkspaceMedia();
      const programAssets = programs.flatMap((program) => {
        const presentation = program.publicPresentation || {};
        return [
          presentation.imageUrl
            ? { type: "image", url: presentation.imageUrl, title: `${program.name} image` }
            : null,
          presentation.introVideoUrl
            ? { type: "video", url: presentation.introVideoUrl, publicId: presentation.introVideoPublicId || "", title: `${program.name} video` }
            : null,
        ].filter(Boolean);
      });
      const unique = new Map(
        [...programAssets, ...contentAssets]
          .filter((asset) => asset.type === type && asset.url)
          .map((asset) => [asset.url, asset]),
      );
      setMedia([...unique.values()]);
      setShowLibrary(type);
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to load the media library.",
      );
    }
  };
  const upload = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("video/") || file.size > 75 * 1024 * 1024)
      return setError("Choose an MP4, WEBM, or MOV video up to 75 MB.");
    try {
      setSaving(true);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const asset = await uploadProgramVideo({
        file: data,
        filename: file.name,
      });
      setEditing((row) => ({
        ...row,
        publicPresentation: {
          ...row.publicPresentation,
          introVideoUrl: asset.url,
          introVideoPublicId: asset.publicId,
        },
      }));
    } catch (err) {
      setError(err.response?.data?.error || "Unable to upload the video.");
    } finally {
      setSaving(false);
    }
  };
  const uploadImage = async (file) => {
    if (!file) return;
    if (
      !/^image\/(png|jpeg|webp)$/.test(file.type) ||
      file.size > 5 * 1024 * 1024
    )
      return setError("Choose a PNG, JPG, or WEBP image up to 5 MB.");
    try {
      setSaving(true);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const asset = await uploadEventImage({ file: data });
      await persistProgramImage(asset.url);
    } catch (err) {
      setError(
        err.response?.data?.error || "Unable to upload the program image.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="website-focused-panel program-website-manager">
      <header className="website-section-heading">
        <div>
          <p className="page-eyebrow">Public programs</p>
          <h3>Programs</h3>
          <p>
            Control which coaching programs visitors can see without changing
            program delivery settings.
          </p>
        </div>
      </header>
      {message ? <p className="discovery-notice">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <div className="program-order-guide">
        <div>
          <strong>Arrange your programs</strong>
          <span>High-value accelerators stay on top. Six-week programs stay together below.</span>
        </div>
        <div className="program-order-guide__actions">
          <span>Drag a program or use the arrows, then save.</span>
          <Button disabled={!orderDirty || saving} loading={saving} onClick={saveOrder}>
            Save program order
          </Button>
        </div>
      </div>
      <section className="comparison-table-manager">
        <header>
          <div>
            <p className="page-eyebrow">Website comparison table</p>
            <h4>Edit “Compare what is included”</h4>
            <p>
              This is the same table visitors see. Click any word or value to
              edit it, then save the complete table once.
            </p>
          </div>
          <Button disabled={!comparisonPrograms.length || saving} loading={saving} onClick={saveComparisonTable}>
            Save entire comparison table
          </Button>
        </header>
        {comparisonPrograms.length > 1 ? (
          <>
            <div className="comparison-table-manager__scroll">
              <table className="comparison-table-editor">
                <caption>Compare what is included</caption>
                <thead>
                  <tr>
                    <th scope="col">Program feature</th>
                    {comparisonPrograms.map((program, index) => (
                      <th scope="col" key={program._id}>
                        <label>
                          Tier heading
                          <input value={comparisonValue(program, "tierLabel", index)} onChange={(event) => patchComparison(program._id, "tierLabel", event.target.value)} />
                        </label>
                        <label>
                          Price displayed
                          <input value={comparisonValue(program, "comparisonPriceLabel", index)} onChange={(event) => patchComparison(program._id, "comparisonPriceLabel", event.target.value)} />
                        </label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Program length", "comparisonDurationLabel"],
                    ["Coaching format", "coachingFormat"],
                  ].map(([label, key]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      {comparisonPrograms.map((program, index) => (
                        <td key={program._id}>
                          <input aria-label={`${label} for ${program.name}`} value={comparisonValue(program, key, index)} onChange={(event) => patchComparison(program._id, key, event.target.value)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {comparisonFeatures.map((feature) => (
                    <tr key={feature}>
                      <th scope="row">
                        <input aria-label={`Feature row ${feature}`} defaultValue={feature} onBlur={(event) => renameComparisonFeature(feature, event.target.value)} />
                      </th>
                      {comparisonPrograms.map((program) => {
                        const included = (program.publicPresentation?.highlights || []).includes(feature);
                        return (
                          <td key={program._id}>
                            <label className="comparison-included-toggle">
                              <input type="checkbox" checked={included} onChange={(event) => toggleComparisonFeature(program._id, feature, event.target.checked)} />
                              <span>{included ? "Included" : "Not included"}</span>
                            </label>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="comparison-feature-adder">
              <label>
                Add another feature row
                <input value={newComparisonFeature} placeholder="Example: Weekly strategy calls" onChange={(event) => setNewComparisonFeature(event.target.value)} />
              </label>
              <Button variant="outline" disabled={!newComparisonFeature.trim()} onClick={addComparisonFeature}>Add feature</Button>
            </div>
          </>
        ) : (
          <p className="comparison-table-manager__empty">
            Publish at least two High Performance Accelerator programs to show and edit the comparison table.
          </p>
        )}
      </section>
      <div className="program-website-list">
        {orderedPrograms.map((program) => {
          const data = program.publicPresentation || {},
            visible =
              program.status === "active" && data.status === "published",
            state =
              program.status !== "active"
                ? "Draft"
                : visible
                  ? "Published"
                  : "Hidden";
          return (
            <article
              key={program._id}
              draggable={!saving}
              className={draggingId === program._id ? "is-dragging" : ""}
              onDragStart={(event) => {
                setDraggingId(program._id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", program._id);
              }}
              onDragEnd={() => setDraggingId("")}
              onDragOver={(event) => {
                if (
                  draggingId &&
                  sectionOf(programs.find((row) => row._id === draggingId) || {}) ===
                    sectionOf(program)
                ) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                moveProgram(
                  event.dataTransfer.getData("text/plain") || draggingId,
                  program._id,
                );
              }}
            >
              <div className="program-website-summary">
                <div className="program-order-controls" aria-label={`Reorder ${program.name}`}>
                  <span className="program-drag-handle" aria-hidden="true">⋮⋮</span>
                  <button type="button" disabled={saving} onClick={() => nudgeProgram(program, -1)} aria-label={`Move ${program.name} earlier`}>↑</button>
                  <button type="button" disabled={saving} onClick={() => nudgeProgram(program, 1)} aria-label={`Move ${program.name} later`}>↓</button>
                </div>
                <span
                  className={`website-status-chip ${visible ? "is-live" : state === "Draft" ? "is-draft" : ""}`}
                >
                  {state}
                </span>
                <span className="program-section-chip">
                  {sectionOf(program) === "accelerator"
                    ? "High Performance Accelerator"
                    : "Intensive Program"}
                </span>
                <h4>{program.name}</h4>
                <dl>
                  <div>
                    <dt>Price</dt>
                    <dd>{program.defaultPrice?.amount != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: program.defaultPrice.currency || "USD", maximumFractionDigits: 0 }).format(program.defaultPrice.amount) : "Not set"}</dd>
                  </div>
                  <div>
                    <dt>Visibility</dt>
                    <dd>
                      {visible ? "Shown on website" : "Not shown publicly"}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="program-website-actions">
                <Button
                  variant="outline"
                  onClick={() =>
                    setEditing(presentationForEditing(program))
                  }
                >
                  Edit Website Content
                </Button>
                {visible ? (
                  <a
                    href={`${websiteUrl.replace(/\/$/, "")}/#programs`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on website ↗
                  </a>
                ) : null}
                <Button
                  variant={visible ? "ghost" : "primary"}
                  disabled={saving || (program.status !== "active" && !visible)}
                  onClick={() => setVisibility(program, !visible)}
                >
                  {visible ? "Hide" : "Publish"}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      <Modal
        isOpen={Boolean(editing)}
        onClose={() => {
          setEditing(null);
          setShowLibrary(false);
        }}
        title={editing ? `Edit ${editing.name}` : "Edit program"}
        footer={
          <div className="modal-action-row">
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button loading={saving} onClick={save}>
              Save website presentation
            </Button>
          </div>
        }
      >
        {editing ? (
          <div className="program-presentation-form">
            <section className="program-editor-group">
              <header>
                <span>1</span>
                <div>
                  <h4>Publishing</h4>
                  <p>Choose whether this active program appears publicly.</p>
                </div>
              </header>
              <label className="website-toggle">
                <input
                  type="checkbox"
                  checked={editing.publicPresentation?.status === "published"}
                  onChange={(e) =>
                    patch("status", e.target.checked ? "published" : "hidden")
                  }
                />
                <span>
                  <strong>Show on website</strong>
                  <small>
                    A program name and description are required to publish.
                  </small>
                </span>
              </label>
            </section>
            <section className="program-editor-group">
              <header>
                <span>2</span>
                <div>
                  <h4>Public content</h4>
                  <p>Write the complete visitor-facing program information.</p>
                </div>
              </header>
              <label>
                Program name shown on the website
                <input
                  value={editing.publicPresentation?.title || editing.name}
                  onChange={(e) => patch("title", e.target.value)}
                />
              </label>
              <label>
                Program description
                <textarea
                  rows="9"
                  value={editing.publicPresentation?.description || ""}
                  onChange={(e) => patch("description", e.target.value)}
                />
              </label>
              <fieldset className="program-video-picker">
                <legend>Program image</legend>
                {editing.publicPresentation?.imageUrl ? (
                  <div className="program-video-preview">
                    <img src={editing.publicPresentation.imageUrl} alt="" />
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => chooseMedia("image")}
                      >
                        Replace image
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        onClick={async () => {
                          try {
                            setSaving(true);
                            await persistProgramImage("");
                          } catch (err) {
                            setError(
                              err.response?.data?.error ||
                                "Unable to remove the program image.",
                            );
                          } finally {
                            setSaving(false);
                          }
                        }}
                      >
                        Remove image
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="program-video-empty">
                    <div>
                      <label className="website-upload-button">
                        Upload image
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(e) => uploadImage(e.target.files?.[0])}
                        />
                      </label>
                      <Button
                        variant="outline"
                        onClick={() => chooseMedia("image")}
                      >
                        Choose existing image
                      </Button>
                    </div>
                  </div>
                )}
                {showLibrary === "image" ? (
                  <div className="website-media-library">
                    <strong>Workspace media library</strong>
                    <p>Images already used by your programs or content appear here. Upload a new image above to add something new.</p>
                    {media.length ? (
                      media.map((asset) => (
                        <button
                          key={asset.url}
                          type="button"
                          disabled={saving}
                          onClick={async () => {
                            try {
                              setSaving(true);
                              await persistProgramImage(asset.url);
                              setShowLibrary(false);
                            } catch (err) {
                              setError(
                                err.response?.data?.error ||
                                  "Unable to save the program image.",
                              );
                            } finally {
                              setSaving(false);
                            }
                          }}
                        >
                          <img src={asset.url} alt="" />
                          <span>{asset.title || "Workspace image"}</span>
                        </button>
                      ))
                    ) : (
                      <p>No reusable images are in the media library yet.</p>
                    )}
                  </div>
                ) : null}
              </fieldset>
            </section>
            <section className="program-editor-group">
              <header>
                <span>3</span>
                <div>
                  <h4>Comparison table</h4>
                  <p>Edit how this program appears in “Compare what is included.”</p>
                </div>
              </header>
              <label>
                Tier heading
                <input
                  placeholder="Example: IMPLEMENT"
                  value={editing.publicPresentation?.tierLabel || ""}
                  onChange={(e) => patch("tierLabel", e.target.value)}
                />
              </label>
              <label>
                Price shown in comparison
                <input
                  placeholder="Leave blank to use the program price"
                  value={editing.publicPresentation?.comparisonPriceLabel || ""}
                  onChange={(e) => patch("comparisonPriceLabel", e.target.value)}
                />
              </label>
              <label>
                Program length shown in comparison
                <input
                  placeholder="Leave blank to use the program duration"
                  value={editing.publicPresentation?.comparisonDurationLabel || ""}
                  onChange={(e) => patch("comparisonDurationLabel", e.target.value)}
                />
              </label>
              <label>
                Coaching format
                <input
                  placeholder="Example: ONE-ON-ONE or BOOTCAMP"
                  value={editing.publicPresentation?.coachingFormat || ""}
                  onChange={(e) => patch("coachingFormat", e.target.value)}
                />
              </label>
              <label>
                Included features (one per line)
                <textarea
                  rows="6"
                  value={(editing.publicPresentation?.highlights || []).join("\n")}
                  onChange={(e) =>
                    patch(
                      "highlights",
                      e.target.value
                        .split("\n")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
              <small>
                Leave an override blank to keep using the saved price, duration, or automatic label.
              </small>
            </section>
            <section className="program-editor-group">
              <header>
                <span>4</span>
                <div>
                  <h4>Intro video</h4>
                  <p>
                    Add an optional hosted video without exposing technical
                    URLs.
                  </p>
                </div>
              </header>
              <fieldset className="program-video-picker">
                <legend className="sr-only">Intro video</legend>
                {editing.publicPresentation?.introVideoUrl ? (
                  <div className="program-video-preview">
                    <video
                      src={editing.publicPresentation.introVideoUrl}
                      controls
                      preload="metadata"
                    />
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => chooseMedia("video")}
                      >
                        Replace video
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          patch("introVideoUrl", "");
                          patch("introVideoPublicId", "");
                        }}
                      >
                        Remove video
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="program-video-empty">
                    <p>
                      Add an optional welcome video to the public program
                      presentation.
                    </p>
                    <div>
                      <label className="website-upload-button">
                        Upload video
                        <input
                          type="file"
                          accept="video/mp4,video/webm,video/quicktime"
                          onChange={(e) => upload(e.target.files?.[0])}
                        />
                      </label>
                      <Button
                        variant="outline"
                        onClick={() => chooseMedia("video")}
                      >
                        Choose existing media
                      </Button>
                    </div>
                  </div>
                )}
                {showLibrary === "video" ? (
                  <div className="website-media-library">
                    <strong>Choose existing media</strong>
                    {media.length ? (
                      media.map((asset) => (
                        <button
                          key={`${asset.contentId}-${asset.publicId || asset.url}`}
                          type="button"
                          onClick={() => {
                            patch("introVideoUrl", asset.url);
                            patch("introVideoPublicId", asset.publicId || "");
                            setShowLibrary(false);
                          }}
                        >
                          <video src={asset.url} preload="metadata" />
                          <span>{asset.title || "Workspace video"}</span>
                        </button>
                      ))
                    ) : (
                      <p>No reusable videos are in the media library yet.</p>
                    )}
                  </div>
                ) : null}
              </fieldset>
            </section>
            <section className="program-editor-group">
              <header>
                <span>5</span>
                <div>
                  <h4>Placement</h4>
                  <p>Choose where this program appears. Reorder programs from the list after saving.</p>
                </div>
              </header>
              <div className="program-placement-summary">
                <strong>Website section</strong>
                <span>
                  {sectionOf(editing) === "accelerator"
                    ? "High Performance Accelerators"
                    : "Intensive 6-Week Programs"}
                </span>
                <small>Lead Porch places programs automatically from their saved price.</small>
              </div>
              <label className="website-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(editing.publicPresentation?.featured)}
                  onChange={(e) => patch("featured", e.target.checked)}
                />
                <span>
                  <strong>Show “Most Popular”</strong>
                  <small>Highlights this program with the permanent green border.</small>
                </span>
              </label>
            </section>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
