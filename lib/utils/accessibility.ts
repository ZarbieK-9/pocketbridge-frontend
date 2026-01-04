/**
 * Accessibility Utilities
 * 
 * Focus management, keyboard navigation, and ARIA helpers
 */

/**
 * Trap focus within an element
 */
export function trapFocus(element: HTMLElement): () => void {
  const focusableElements = element.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];

  const handleTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    }
  };

  element.addEventListener('keydown', handleTab);
  firstElement?.focus();

  return () => {
    element.removeEventListener('keydown', handleTab);
  };
}

/**
 * Restore focus to previous element
 */
export function restoreFocus(previousElement: HTMLElement | null): void {
  if (previousElement && document.contains(previousElement)) {
    previousElement.focus();
  }
}

/**
 * Announce message to screen readers
 */
export function announceToScreenReader(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', priority);
  announcement.setAttribute('aria-atomic', 'true');
  announcement.className = 'sr-only';
  announcement.textContent = message;

  document.body.appendChild(announcement);

  setTimeout(() => {
    document.body.removeChild(announcement);
  }, 1000);
}

/**
 * Check if element is focusable
 */
export function isFocusable(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  const tabIndex = element.getAttribute('tabindex');

  if (tabIndex === '-1') return false;
  if (tabIndex !== null) return true;

  const focusableTags = ['a', 'button', 'input', 'select', 'textarea'];
  if (focusableTags.includes(tagName)) {
    if (tagName === 'a' && !element.getAttribute('href')) return false;
    if ((element as HTMLInputElement).disabled) return false;
    return true;
  }

  return false;
}

/**
 * Get all focusable elements within container
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}

/**
 * Handle keyboard navigation
 */
export function handleKeyboardNavigation(
  event: KeyboardEvent,
  options: {
    onEnter?: () => void;
    onEscape?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    onArrowLeft?: () => void;
    onArrowRight?: () => void;
  }
): void {
  switch (event.key) {
    case 'Enter':
      options.onEnter?.();
      break;
    case 'Escape':
      options.onEscape?.();
      break;
    case 'ArrowUp':
      options.onArrowUp?.();
      break;
    case 'ArrowDown':
      options.onArrowDown?.();
      break;
    case 'ArrowLeft':
      options.onArrowLeft?.();
      break;
    case 'ArrowRight':
      options.onArrowRight?.();
      break;
  }
}

/**
 * Skip to main content (for keyboard navigation)
 */
export function skipToMainContent(): void {
  const mainContent = document.querySelector('main') || document.querySelector('[role="main"]');
  if (mainContent instanceof HTMLElement) {
    mainContent.focus();
    mainContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}



