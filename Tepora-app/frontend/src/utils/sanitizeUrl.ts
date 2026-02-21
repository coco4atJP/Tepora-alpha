/**
 * URL Sanitization Utility
 *
 * Shared URL sanitizer for preventing XSS via javascript:, data:, and other
 * dangerous schemes. Only allows http: and https: protocols.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Sanitize a URL by validating its protocol scheme.
 * Returns "#" for invalid, empty, or dangerous URLs.
 */
export const sanitizeUrl = (url: string): string => {
    if (!url || url === "#") return "#";
    try {
        const parsed = new URL(url);
        return ALLOWED_PROTOCOLS.has(parsed.protocol) ? url : "#";
    } catch {
        return "#";
    }
};
