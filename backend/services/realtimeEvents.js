const { EventEmitter } = require("events");

// Single-process in-memory pub/sub for pushing "something changed" notices to
// open browser tabs via Server-Sent Events. This is intentionally not a queue
// or a message broker — if Lead Porch ever runs more than one backend
// instance at once, this would need to move to a shared broker (e.g. Redis)
// so an event raised on one instance reaches clients connected to another.
const bus = new EventEmitter();
bus.setMaxListeners(0);

function emitWorkspaceEvent(workspaceId, event) {
  if (!workspaceId) return;
  bus.emit(String(workspaceId), event);
}

function subscribe(workspaceId, listener) {
  const key = String(workspaceId);
  bus.on(key, listener);
  return () => bus.off(key, listener);
}

module.exports = { emitWorkspaceEvent, subscribe };
