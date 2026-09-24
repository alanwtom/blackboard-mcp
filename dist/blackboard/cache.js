/**
 * Small in-process TTL cache. The MCP server is long-running, so this keeps
 * request volume to Blackboard low without persisting anything to disk.
 */
export class TTLCache {
    store = new Map();
    maxEntries;
    constructor(maxEntries = 200) {
        this.maxEntries = maxEntries;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        // Refresh recency for LRU eviction.
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }
    set(key, value, ttlMs) {
        if (this.store.size >= this.maxEntries) {
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined)
                this.store.delete(oldest);
        }
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
    async wrap(key, ttlMs, fn) {
        const hit = this.get(key);
        if (hit !== undefined)
            return hit;
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
    }
    clear() {
        this.store.clear();
    }
}
/** Shared cache for the current process (CLI or MCP server). */
export const globalCache = new TTLCache();
export const TTL = {
    identity: 30 * 60_000,
    courses: 10 * 60_000,
    content: 5 * 60_000,
    announcements: 5 * 60_000,
    gradebookColumns: 5 * 60_000,
    calendar: 5 * 60_000,
    assignments: 5 * 60_000,
    grades: 5 * 60_000,
};
