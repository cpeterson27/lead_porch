import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import "./EmailBodyEditor.css";

const FONTS = [
  ["Arial, sans-serif", "Arial"],
  ["Georgia, serif", "Georgia"],
  ["'Times New Roman', serif", "Times New Roman"],
  ["'Courier New', monospace", "Courier New"],
  ["Verdana, sans-serif", "Verdana"],
];

// A focused, "good enough" rich-text editor for campaign email bodies —
// bold/italic/underline, alignment, font, inline images, and an inline
// styled button — built on contentEditable + document.execCommand rather
// than a WYSIWYG library, matching the scope actually needed here. Saved
// value is real HTML (the editable div's innerHTML); see
// utils/outreachGenerator.js for how that HTML is detected and rendered
// as-is (instead of being escaped/paragraph-wrapped like old plain-text
// campaign bodies).
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

  useEffect(() => {
    const node = editableRef.current;
    if (node && value !== lastEmitted.current && node.innerHTML !== (value || "")) {
      node.innerHTML = /^\s*</.test(value || "") ? value : plainTextToHtml(value || "");
    }
    lastEmitted.current = value;
  }, [value]);

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

  useImperativeHandle(ref, () => ({
    insertText(text) {
      exec("insertText", text);
    },
  }));

  const preventBlur = (event) => event.preventDefault();

  const handleImageFile = async (file) => {
    if (!file || !onUploadImage) return;
    const url = await onUploadImage(file);
    if (url) exec("insertImage", url);
  };

  const insertButton = () => {
    const label = window.prompt("Button text", "Learn more");
    if (!label) return;
    const url = window.prompt("Button link (https://...)", "https://");
    if (!url) return;
    exec(
      "insertHTML",
      `<a href="${url}" style="display:inline-block;padding:12px 28px;background:#173f36;color:#ffffff;border-radius:999px;text-decoration:none;font-weight:700;letter-spacing:0.02em;">${String(label).replace(/[<>&]/g, "")}</a>&nbsp;`,
    );
  };

  return (
    <div className="email-body-editor">
      <div className="email-body-toolbar" role="toolbar" aria-label="Message formatting">
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("bold")} title="Bold"><strong>B</strong></button>
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("italic")} title="Italic"><em>I</em></button>
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("underline")} title="Underline"><u>U</u></button>
        <span className="email-body-toolbar__divider" />
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("justifyLeft")} title="Align left">⟸</button>
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("justifyCenter")} title="Align center">☰</button>
        <button type="button" onMouseDown={preventBlur} onClick={() => exec("justifyRight")} title="Align right">⟹</button>
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
      <div
        ref={editableRef}
        className="email-body-editable"
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
      />
    </div>
  );
});

export default EmailBodyEditor;
