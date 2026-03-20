import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { chatMachine } from './chatMachine';

describe('chatMachine', () => {
    it('starts in idle state', () => {
        const actor = createActor(chatMachine).start();
        expect(actor.getSnapshot().matches('idle')).toBe(true);
    });

    it('transitions to generating.thinking on SEND_MESSAGE with valid payload', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        expect(actor.getSnapshot().matches({ generating: 'thinking' })).toBe(true);
    });

    it('ignores SEND_MESSAGE with empty payload (guard check)', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: '   ' });
        expect(actor.getSnapshot().matches('idle')).toBe(true);
    });

    it('transitions to streaming on RECV_CHUNK', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        actor.send({ type: 'RECV_CHUNK', payload: 'Test chunk' });

        expect(actor.getSnapshot().matches({ generating: 'streaming' })).toBe(true);
    });

    it('transitions to tool_confirm on TOOL_CALL', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        actor.send({ type: 'TOOL_CALL', toolName: 'test', args: {} });

        expect(actor.getSnapshot().matches({ generating: 'tool_confirm' })).toBe(true);
    });

    it('returns to thinking when tool is confirmed', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        actor.send({ type: 'TOOL_CALL', toolName: 'test', args: {} });
        actor.send({ type: 'CONFIRM_TOOL', payload: {} });

        expect(actor.getSnapshot().matches({ generating: 'thinking' })).toBe(true);
    });

    it('cancels tool execution and returns to idle on CANCEL_TOOL', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        actor.send({ type: 'TOOL_CALL', toolName: 'test', args: {} });
        actor.send({ type: 'CANCEL_TOOL' });

        expect(actor.getSnapshot().matches('idle')).toBe(true);
    });

    it('returns to idle on DONE event when streaming', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        actor.send({ type: 'RECV_CHUNK', payload: 'chunk' });
        actor.send({ type: 'DONE' });

        expect(actor.getSnapshot().matches('idle')).toBe(true);
    });

    it('transitions to error state on ERROR event', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        actor.send({ type: 'ERROR', error: new Error('test') });

        expect(actor.getSnapshot().matches('error')).toBe(true);
    });

    it('can reset from error state', () => {
        const actor = createActor(chatMachine).start();
        actor.send({ type: 'SEND_MESSAGE', payload: 'Hello' });
        actor.send({ type: 'ERROR', error: new Error('test') });
        actor.send({ type: 'RESET' });

        expect(actor.getSnapshot().matches('idle')).toBe(true);
    });
});
