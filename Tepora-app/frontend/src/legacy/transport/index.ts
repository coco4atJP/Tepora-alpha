import type { ToolConfirmationResponse } from "../../types";

export interface Transport {
  /**
   * Send a raw message to the backend.
   */
  send(data: Record<string, unknown>): void;

  /**
   * Subscribe to messages from the backend.
   * @returns A function to unsubscribe.
   */
  subscribe(handler: (message: unknown) => void): () => void;

  /**
   * Convenience method to confirm or reject a tool execution.
   */
  confirmTool(requestId: string, response: ToolConfirmationResponse): void;
}

