import { EventEmitter } from 'node:events';
import type { DomainEventName } from '@tesor_gp/shared';
import type { Logger } from './logger';

export type EventPayload = Record<string, unknown>;
export type EventHandler = (payload: EventPayload) => void | Promise<void>;

/**
 * In-process domain event bus. Handlers run asynchronously and their failures are logged, never thrown into the
 * emitting request (non-critical consumers must not break auth, playback or payments).
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: Logger) {
    this.emitter.setMaxListeners(50);
  }

  on(name: DomainEventName, handler: EventHandler): void {
    this.emitter.on(name, (payload: EventPayload) => {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => this.logger.error({ err, event: name }, 'event handler failed'));
    });
  }

  emit(name: DomainEventName, payload: EventPayload = {}): void {
    this.emitter.emit(name, payload);
  }
}
