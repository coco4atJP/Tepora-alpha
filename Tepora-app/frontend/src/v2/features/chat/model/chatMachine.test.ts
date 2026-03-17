import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { chatFlowMachine } from "./chatMachine";

describe("chatFlowMachine", () => {
	it("tracks stream and tool confirmation without storing message bodies", () => {
		const actor = createActor(chatFlowMachine).start();

		actor.send({ type: "SEND", requestId: "req-1" });
		expect(actor.getSnapshot().value).toBe("sending");
		expect(actor.getSnapshot().context.activeRequestId).toBe("req-1");

		actor.send({ type: "STREAM_EVENT", streamId: "stream-1" });
		expect(actor.getSnapshot().value).toBe("streaming");
		expect(actor.getSnapshot().context.activeStreamId).toBe("stream-1");

		actor.send({
			type: "TOOL_CONFIRMATION_REQUIRED",
			requestId: "tool-1",
		});
		expect(actor.getSnapshot().value).toBe("awaitingToolConfirmation");
		expect(actor.getSnapshot().context.pendingToolRequestId).toBe("tool-1");

		actor.send({ type: "TOOL_CONFIRMATION_RESOLVED" });
		expect(actor.getSnapshot().value).toBe("sending");
		expect(actor.getSnapshot().context.pendingToolRequestId).toBeNull();
	});

	it("settles into stopped when reconnect invalidates the active flow", () => {
		const actor = createActor(chatFlowMachine).start();

		actor.send({ type: "SEND", requestId: "req-2" });
		actor.send({ type: "STREAM_EVENT", streamId: "stream-2" });
		actor.send({ type: "RECONNECT_INVALIDATED" });

		expect(actor.getSnapshot().value).toBe("stopped");
		expect(actor.getSnapshot().context.activeRequestId).toBeNull();
		expect(actor.getSnapshot().context.activeStreamId).toBeNull();
		expect(actor.getSnapshot().context.pendingToolRequestId).toBeNull();
		expect(actor.getSnapshot().context.stopRequested).toBe(false);
	});
});
