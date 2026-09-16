import { useEffect } from 'react'
import './Modal.css'
import { ModalPortal, useModalLayer } from './ModalLayer.jsx'

export default function Modal({ isOpen, onClose, title, children, footer, size = "default", className = "" }) {
  useModalLayer(isOpen)

  useEffect(() => {
    if (!isOpen) {
      return undefined
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose?.()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  return <ModalPortal>
    <div className="modal-root" aria-modal="true" role="dialog">
      <button className="modal-backdrop" onClick={onClose} aria-label="Close modal" />
      <div
        className={`modal-panel ${size === "workspace" ? "modal-panel--workspace" : ""} ${className}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close modal">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  </ModalPortal>
}
