import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "./EmailBodyEditor.css";

const FONTS = [
  ["Arial, sans-serif", "Arial"],
  ["Georgia, serif", "Georgia"],
  ["'Times New Roman', serif", "Times New Roman"],
  ["'Courier New', monospace", "Courier New"],
  ["Verdana, sans-serif", "Verdana"],
];
const IMAGE_WIDTHS = [
  [25, "25%"],
  [50, "50%"],
  [75, "75%"],
  [100, "Full width"],
];

// A focused, "good enough" rich-text editor for campaign email bodies —
// bold/italic/underline, alignment, font, resizable inline images, and an
// alignable inline button — built on contentEditable + document.execCommand
// rather than a WYSIWYG library, matching the scope actually needed here.
// Saved value is real HTML (the editable div's innerHTML); see
// utils/outreachGenerator.js for how that HTML is detected and rendered
// as-is (instead of being escaped/paragraph-wrapped like old plain-text
// campaign bodies).
//
// Images and buttons are each inserted inside their own wrapper <div
// data-block="image|button">. That wrapper, not the inline element itself,
// is what "align left/center/right" sets text-align on — an <img> or <a>
// alone has no useful text-align of its own, so without a block wrapper
// alignment would have nothing to act on for either. Clicking an image or
// button selects its wrapper (outlined) so the toolbar's align buttons and
// the image-size buttons act on that element specifically instead of
// falling through to the generic text-selection alignment.

// Older campaigns saved plain typed text (with blank-line paragraph breaks
// and no markup at all). Dropped straight into innerHTML, a browser
// collapses those newlines into one run-on line — convert to paragraphs
// once on load so opening an old campaign doesn't look broken. Once saved
// from here, the body is real HTML and this no longer applies.
function plainTextToHtml(value) {
  if (!String(value).trim()) return "";
  return String(value)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

const EmailBodyEditor = forwardRef(function EmailBodyEditor(
  { value, onChange, onUploadImage, uploading },
  ref,
) {
  const editableRef = useRef(null);
  const lastEmitted = useRef(value);
  const selectedBlockRef = useRef(null);
  const [selectedBlockKind, setSelectedBlockKind] = useState(null);

  useEffect(() => {
    const node = editableRef.current;
    if (node && value !== lastEmitted.current && node.innerHTML !== (value || "")) {
      node.innerHTML = /^\s*</.test(value || "") ? value : plainTextToHtml(value || "");
      // The previously selected block (if any) just got replaced/detached.
      selectedBlockRef.current = null;
      setSelectedBlockKind(null);
    }
    lastEmitted.current = value;
  }, [value]);

  useEffect(() => {
    // Best-effort native drag-resize handles on images, in addition to the
    // explicit size buttons below (which work regardless of browser support
    // for this legacy-but-still-functional command).
    try {
      document.execCommand("enableObjectResizing", false, "true");
    } catch {
      // Unsupported in this browser — the explicit size buttons still work.
    }
  }, []);

  const emit = () => {
    const html = editableRef.current?.innerHTML || "";
    lastEmitted.current = html;
    onChange(html);
  };

  const exec = (command, arg) => {
    editableRef.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  };

  const clearSelectedBlock = () => {
    selectedBlockRef.current?.classList.remove("email-block--selected");
    selectedBlockRef.current = null;
    setSelectedBlockKind(null);
  };

  const selectBlock = (node) => {
    if (selectedBlockRef.current === node) return;
    clearSelectedBlock();
    selectedBlockRef.current = node;
    node.classList.add("email-block--selected");
    setSelectedBlockKind(node.dataset.block);
  };

  const handleEditableClick = (event) => {
    // Clicking a button's <a> inside contentEditable would otherwise try to
    // navigate to its href — this editor treats a click as "select it",
    // never "follow it".
    if (event.target.closest?.("a")) event.preventDefault();
    const block = event.target.closest?.("[data-block]");
    if (block && editableRef.current?.contains(block)) {
      selectBlock(block);
    } else {
      clearSelectedBlock();
    }
  };

  const align = (direction) => {
    if (selectedBlockRef.current) {
      selectedBlockRef.current.style.textAlign = direction;
      emit();
      return;
    }
    exec(direction === "left" ? "justifyLeft" : direction === "right" ? "justifyRight" : "justifyCenter");
  };

  const setImageWidth = (percent) => {
    const block = selectedBlockRef.current;
    const img = block?.dataset.block === "image" ? block.querySelector("img") : null;
    if (!img) return;
    img.style.width = `${percent}%`;
    img.style.height = "auto";
    emit();
  };

  useImperativeHandle(ref, () => ({
    insertText(text) {
      exec("insertText", text);
    },
  }));

  const preventBlur = (event) => event.preventDefault();

  const handleImageFile = async (file) => {
    if (!file || !onUploadImage) return;
    const url = await onUploadImage(file);
    if (!url) return;
    exec(
      "insertHTML",
      `<div data-block="image" style="text-align:center;margin:16px 0;"><img src="${url}" style="width:60%;height:auto;max-width:100%;"></div><p><br></p>`,
    );
  };

  const insertButton = () => {
    const label = window.prompt("Button text", "Learn more");
    if (!label) return;
    const url = window.prompt("Button link (https://...)", "https://");
    if (!url) return;
    exec(
      "insertHTML",
      `<div data-block="button" style="text-align:left;margin:16px 0;"><a href="${url}" style="display:inline-block;padding:12px 28px;background:#173f36;color:#ffffff;border-radius:999px;text-decoration:none;font-weight:700;letter-spacing:0.02em;">${String(label).replace(/[<>&]/g, "")}</a></div><p><br></p>`,
    );
  };

  return (
    <div className="email-body-editor">
      <div className="email-body-toolbar" role="toolbar" aria-label="Message formatting">
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("bold")} title="Bold"><strong>B</strong></button>
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("italic")} title="Italic"><em>I</em></button>
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("underline")} title="Underline"><u>U</u></button>
        <span className="email-body-toolbar__divider" />
        <button type="button" onMouseDown={preventBlur} onClick={() => align("left")} title="Align left">⟸</button>
        <button type="button" onMouseDown={preventBlur} onClick={() => align("center")} title="Align center">☰</button>
        <button type="button" onMouseDown={preventBlur} onClick={() => align("right")} title="Align right">⟹</button>
        <span className="email-body-toolbar__divider" />
        <select
          onMouseDown={preventBlur}
          defaultValue=""
          aria-label="Font family"
          onChange={(event) => {
            if (event.target.value) exec("fontName", event.target.value);
            event.target.value = "";
          }}
        >
          <option value="" disabled>Font…</option>
          {FONTS.map(([css, label]) => (
            <option key={css} value={css}>{label}</option>
          ))}
        </select>
        <select
          onMouseDown={preventBlur}
          defaultValue=""
          aria-label="Font size"
          onChange={(event) => {
            if (event.target.value) exec("fontSize", event.target.value);
            event.target.value = "";
          }}
        >
          <option value="" disabled>Size…</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="7">Huge</option>
        </select>
        <span className="email-body-toolbar__divider" />
        <label className="email-body-toolbar__upload">
          {uploading ? "Uploading…" : "Insert image"}
          <input
            type="file"
            accept="image/*"
            disabled={uploading}
            onChange={(event) => {
              handleImageFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        <button type="button" onMouseDown={preventBlur} onClick={insertButton} title="Insert a styled button link">Insert button</button>
      </div>
      {selectedBlockKind === "image" && (
        <div className="email-body-toolbar email-body-toolbar--secondary" role="toolbar" aria-label="Image size">
          <span>Image width:</span>
          {IMAGE_WIDTHS.map(([percent, label]) => (
            <button key={percent} type="button" onMouseDown={preventBlur} onClick={() => setImageWidth(percent)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {selectedBlockKind && (
        <p className="email-body-toolbar__hint">
          {selectedBlockKind === "image" ? "Image" : "Button"} selected — use the align buttons above,
          {selectedBlockKind === "image" ? " the width buttons below, or drag its corner to resize." : ""}
          {" "}Click elsewhere to deselect.
        </p>
      )}
      <div
        ref={editableRef}
        className="email-body-editable"
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onClick={handleEditableClick}
      />
    </div>
  );
});

export default EmailBodyEditor;
