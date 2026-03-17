import { describe, expect, it } from "vitest";
import {
	chatPipelineReducer,
	createInitialChatPipelineState,
} from "./messagePipeline";

describe("chatPipelineReducer", () => {
	it("buffers out-of-order chunk events until the missing sequence arrives", () => {
		let state = createInitialChatPipelineState();
		state = chatPipelineReducer(state, {
			type: "TRANSPORT_MESSAGE",
			message: {
				type: "chunk",
				eventId: "event-2",
				streamId: "stream-1",
				seq: 2,
				emittedAt: "2026-03-17T00:00:00.000Z",
				message: "B",
			},
		});

		expect(state.messages).toHaveLength(0);

		state = chatPipelineReducer(state, {
			type: "TRANSPORT_MESSAGE",
			message: {
				type: "chunk",
				eventId: "event-1",
				streamId: "stream-1",
				seq: 1,
				emittedAt: "2026-03-17T00:00:00.000Z",
				message: "A",
			},
		});

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0].content).toBe("AB");
	});

	it("drops duplicate transport events by eventId", () => {
		let state = createInitialChatPipelineState();
		state = chatPipelineReducer(state, {
			type: "TRANSPORT_MESSAGE",
			message: {
				type: "chunk",
				eventId: "dup-event",
				streamId: "stream-1",
				seq: 1,
				emittedAt: "2026-03-17T00:00:00.000Z",
				message: "Hello",
			},
		});
		state = chatPipelineReducer(state, {
			type: "TRANSPORT_MESSAGE",
			message: {
				type: "chunk",
				eventId: "dup-event",
				streamId: "stream-1",
				seq: 1,
				emittedAt: "2026-03-17T00:00:00.000Z",
				message: "Hello",
			},
		});

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0].content).toBe("Hello");
	});
});
