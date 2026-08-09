// SPDX-License-Identifier: GPL-3.0-only

export type EventMap = object;
type EventListener<Payload> = (payload: Payload) => void;

export class EventBus<Events extends EventMap> {
  readonly #listeners = new Map<keyof Events, Set<EventListener<Events[keyof Events]>>>();

  on<Key extends keyof Events>(event: Key, listener: EventListener<Events[Key]>): () => void {
    const listeners = this.#listeners.get(event) ?? new Set<EventListener<Events[keyof Events]>>();
    listeners.add(listener as EventListener<Events[keyof Events]>);
    this.#listeners.set(event, listeners);
    return () => listeners.delete(listener as EventListener<Events[keyof Events]>);
  }

  once<Key extends keyof Events>(event: Key, listener: EventListener<Events[Key]>): () => void {
    const off = this.on(event, (payload) => { off(); listener(payload); });
    return off;
  }

  emit<Key extends keyof Events>(event: Key, payload: Events[Key]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try { listener(payload); } catch { /* Consumer listeners cannot corrupt editorial commands. */ }
    }
  }

  clear(): void { this.#listeners.clear(); }
}
