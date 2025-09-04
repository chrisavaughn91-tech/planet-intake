// Lightweight event bus for progress streaming
const { EventEmitter } = require('events');
const bus = new EventEmitter();

// Helper to send structured events
function emit(type, payload = {}) {
  bus.emit('evt', { type, ts: Date.now(), ...payload });
}

module.exports = { bus, emit };
