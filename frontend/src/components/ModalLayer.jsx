import { createPortal } from "react-dom";

export function ModalPortal({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
