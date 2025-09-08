// Lightweight event bus for progress streaming
import { EventEmitter } from 'events';
export const bus = new EventEmitter();

// Helper to send structured events
export function emit(type, payload = {}) {
  bus.emit('evt', { type, ts: Date.now(), ...payload });
}

// bus is imported by server.js to broadcast events over SSE
