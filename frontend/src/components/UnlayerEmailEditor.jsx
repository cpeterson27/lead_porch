import { forwardRef, useImperativeHandle, useRef } from "react";
import EmailEditor from "react-email-editor";

// Personalization tokens available in Unlayer's merge-tag picker (the {}
// button in its text tool). These map 1:1 to the {{token}} placeholders
// utils/outreachGenerator.js already fills in per recipient at send/preview
// time — Unlayer only inserts the literal "{{firstName}}" text into the
// exported HTML, it never resolves it itself, so the existing backend
// personalization pipeline needs no changes.
const MERGE_TAGS = {
  firstName: { name: "First name", value: "{{firstName}}", sample: "Alex" },
  company: { name: "Company / community", value: "{{company}}", sample: "Acme Multifamily" },
  campaignName: { name: "Campaign name", value: "{{campaignName}}", sample: "Deal to Close Bootcamp" },
  eventDate: { name: "Event date", value: "{{eventDate}}", sample: "Saturday, September 12, 2026" },
  eventLink: { name: "Registration link", value: "{{eventLink}}", sample: "https://example.com/register" },
};

const DEBOUNCE_MS = 600;

// A genuinely empty design. Passed explicitly whenever there's no saved
// designJson, instead of leaving Unlayer to decide what "no design" means —
// left unspecified, some editor versions/configurations reopen whatever was
// last edited under this Unlayer project rather than a blank canvas, which
// looks exactly like a stale campaign coming back from the dead.
const BLANK_DESIGN = { body: { rows: [], values: {} } };
const COMMON_EMAIL_COLORS = [
  "#000000", "#ffffff", "#f5f5f5", "#6b7280", "#374151",
  "#173f36", "#0f766e", "#15803d", "#2563eb", "#4f46e5",
  "#7c3aed", "#be185d", "#dc2626", "#ea580c", "#ca8a04",
];

// Thin wrapper around Unlayer's embeddable drag-and-drop editor
// (react-email-editor). Renders campaign emails as real blocks (rows,
// columns, images, buttons, text) instead of one plain HTML body, with
// native per-element size/alignment/font controls Unlayer already built.
//
// Two things call out for anyone touching this later:
// - Custom image uploads route through registerCallback("image", ...) —
//   NOT the onImageUpload prop, which only *notifies* after Unlayer's own
//   upload finishes and can't redirect where the file goes. Confirmed from
//   node_modules/@unlayer/types/dist/editor/types.d.ts.
// - Existing campaigns saved before this editor have no designJson (only
//   the old plain/rich-HTML `body`). Unlayer has no supported way to turn
//   arbitrary existing HTML into editable blocks, so those campaigns open
//   to a blank design rather than the old content — the old body is still
//   stored and still sendable until re-saved, just not re-editable here.
const UnlayerEmailEditor = forwardRef(function UnlayerEmailEditor(
  { design, onDesignChange, onUploadImage, accentColor = "#173f36" },
  ref,
) {
  const editorRef = useRef(null);
  const loadedDesignRef = useRef(design || null);
  const debounceTimer = useRef(null);

  useImperativeHandle(ref, () => ({
    exportHtml() {
      return new Promise((resolve, reject) => {
        const editor = editorRef.current?.editor;
        if (!editor) return reject(new Error("The email editor has not finished loading yet."));
        editor.exportHtml((data) => resolve(data));
      });
    },
    // Swaps in a modified design (e.g. one with a logo row inserted) without
    // remounting the whole editor — unlike the `design` prop, this applies
    // immediately to the live canvas. Unlayer's loadDesign() is synchronous.
    loadDesign(design) {
      editorRef.current?.editor?.loadDesign(design);
    },
  }));

  const onLoad = (unlayer) => {
    const colorPickerConfig = {
      colors: [
        { id: "brand_colors", label: "Campaign colors", colors: [accentColor], default: true },
        { id: "common_colors", label: "Common colors", colors: COMMON_EMAIL_COLORS },
        { id: "recent_colors", label: "Recent colors" },
        { id: "template_colors", label: "Colors already used" },
      ],
      recentColors: true,
    };
    // Keep the full picker (hex/RGB plus grouped colors) available even when
    // Unlayer's responsive toolbar initially renders its abbreviated palette.
    unlayer.setColorPickerConfig(colorPickerConfig);
    unlayer.registerCallback("image", async (data, done) => {
      const file = data.accepted?.[0];
      if (!file || !onUploadImage) {
        done({ error: "Image upload is not available right now." });
        return;
      }
      const url = await onUploadImage(file);
      if (url) done({ url });
      else done({ error: "Upload failed." });
    });
    unlayer.loadDesign(design || BLANK_DESIGN);
    loadedDesignRef.current = design || null;
  };

  const handleDesignUpdated = () => {
    if (!onDesignChange) return;
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      editorRef.current?.editor?.exportHtml((data) => onDesignChange(data));
    }, DEBOUNCE_MS);
  };

  return (
    <EmailEditor
      ref={editorRef}
      onLoad={onLoad}
      onDesignUpdated={handleDesignUpdated}
      minHeight={780}
      options={{
        projectId: Number(import.meta.env.VITE_UNLAYER_PROJECT_ID) || undefined,
        mergeTags: MERGE_TAGS,
        mergeTagsConfig: { autocompleteTriggerChar: "{" },
        features: {
          colorPicker: {
            colors: [
              { id: "brand_colors", label: "Campaign colors", colors: [accentColor], default: true },
              { id: "common_colors", label: "Common colors", colors: COMMON_EMAIL_COLORS },
              { id: "recent_colors", label: "Recent colors" },
              { id: "template_colors", label: "Colors already used" },
            ],
            recentColors: true,
          },
          textEditor: {
            inlineColorGroups: ["brand_colors", "common_colors", "recent_colors", "template_colors"],
          },
        },
      }}
    />
  );
});

export default UnlayerEmailEditor;
