// Storage shim: inside Claude.ai artifacts, window.storage is provided by the
// platform. When running standalone (Vite dev server, GitHub Pages, etc.),
// this shim provides the same API backed by the browser's localStorage.
if (typeof window !== "undefined" && !window.storage) {
  const PREFIX = "leave-tracker::";
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(PREFIX + key);
      if (value === null) throw new Error("Key not found: " + key);
      return { key, value, shared: false };
    },
    async set(key, value) {
      localStorage.setItem(PREFIX + key, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      localStorage.removeItem(PREFIX + key);
      return { key, deleted: true, shared: false };
    },
    async list(prefix = "") {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
      }
      return { keys, prefix, shared: false };
    },
  };
}
