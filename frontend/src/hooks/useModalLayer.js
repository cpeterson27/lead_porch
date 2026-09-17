import { useEffect } from "react";

let openLayerCount = 0;
let savedStyles = null;

function lockDocumentScroll() {
  if (openLayerCount === 0) {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    savedStyles = {
      htmlOverflow: document.documentElement.style.overflow,
      htmlOverscroll: document.documentElement.style.overscrollBehavior,
      bodyOverflow: document.body.style.overflow,
      bodyOverscroll: document.body.style.overscrollBehavior,
      bodyPaddingRight: document.body.style.paddingRight,
    };
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
  }
  openLayerCount += 1;
}

function unlockDocumentScroll() {
  openLayerCount = Math.max(0, openLayerCount - 1);
  if (openLayerCount !== 0 || !savedStyles) return;
  document.documentElement.style.overflow = savedStyles.htmlOverflow;
  document.documentElement.style.overscrollBehavior = savedStyles.htmlOverscroll;
  document.body.style.overflow = savedStyles.bodyOverflow;
  document.body.style.overscrollBehavior = savedStyles.bodyOverscroll;
  document.body.style.paddingRight = savedStyles.bodyPaddingRight;
  savedStyles = null;
}

export default function useModalLayer(isOpen) {
  useEffect(() => {
    if (!isOpen) return undefined;
    lockDocumentScroll();
    return unlockDocumentScroll;
  }, [isOpen]);
}
