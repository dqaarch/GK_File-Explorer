// Simple event bus for cross-component dropdown coordination
type EventCallback = (...args: any[]) => void;

class EventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  on(event: string, callback: EventCallback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  emit(event: string, ...args: any[]) {
    this.listeners.get(event)?.forEach(callback => callback(...args));
  }

  off(event: string, callback: EventCallback) {
    this.listeners.get(event)?.delete(callback);
  }
}

// Singleton instance
export const dropdownEventBus = new EventBus();

// Event names
export const DROPDOWN_EVENTS = {
  CONTEXT_MENU_OPENED: 'context-menu-opened',
  CLOSE_ALL_DROPDOWNS: 'close-all-dropdowns',
  QUICK_ACCESS_REFRESH: 'quick-access-refresh',
} as const;
