const WS_APP_PROTOCOL = "tepora.v1";
const WS_TOKEN_PREFIX = "tepora-token.";

function encodeTokenToHex(token: string): string {
	const bytes = new TextEncoder().encode(token);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildWebSocketProtocols(token: string | null): string[] {
	const protocols = [WS_APP_PROTOCOL];
	if (!token || token.trim().length === 0) {
		return protocols;
	}
	protocols.push(`${WS_TOKEN_PREFIX}${encodeTokenToHex(token)}`);
	return protocols;
}
