// In-app navigation without reloading the page. A reload counts as a new visit on iPhone,
// so the browser would ask for the camera and microphone all over again.

const listeners = new Set<() => void>();

export function navigate(path: string) {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", path);
  listeners.forEach((l) => l());
}

export function onNavigate(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}
