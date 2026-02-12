import type { EncryptedEvent } from '@/types';

type EventFilter = string | string[] | ((event: EncryptedEvent) => boolean);
type EventHandler = (event: EncryptedEvent) => void;

type Subscription = {
  filter: EventFilter;
  handler: EventHandler;
};

class EventRouter {
  private subscriptions = new Set<Subscription>();

  subscribe(filter: EventFilter, handler: EventHandler): () => void {
    const subscription: Subscription = { filter, handler };
    this.subscriptions.add(subscription);

    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  publish(event: EncryptedEvent): void {
    for (const subscription of this.subscriptions) {
      if (!this.matches(subscription.filter, event)) continue;
      try {
        subscription.handler(event);
      } catch (error) {
        console.error('[EventRouter] handler error', error);
      }
    }
  }

  private matches(filter: EventFilter, event: EncryptedEvent): boolean {
    if (typeof filter === 'string') {
      return event.type === filter;
    }
    if (Array.isArray(filter)) {
      return filter.includes(event.type);
    }
    return filter(event);
  }
}

export const eventRouter = new EventRouter();
