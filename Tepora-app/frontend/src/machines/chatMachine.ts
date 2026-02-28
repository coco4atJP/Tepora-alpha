import { setup, createActor } from 'xstate';

import { useChatStore } from '../stores/chatStore';

// Define the events that can interact with the chat machine
export type ChatEvent =
    | { type: 'SEND_MESSAGE'; payload: string }
    | { type: 'RECV_START_THINKING' }
    | { type: 'RECV_CHUNK'; payload: string; metadata?: { mode?: 'search' | 'chat' | 'agent'; agentName?: string; nodeId?: string } }
    | { type: 'TOOL_CALL'; toolName: string; args: Record<string, unknown> }
    | { type: 'CONFIRM_TOOL'; payload: unknown }
    | { type: 'CANCEL_TOOL' }
    | { type: 'ERROR'; error: Error }
    | { type: 'DONE' }
    | { type: 'RESET' }
    | { type: 'FLUSH_BUFFER' };

// Define the context (extended state) if necessary
export interface ChatContext {
    currentMessage: string;
    errorMessage: string | null;
    pendingTool: { name: string; args: Record<string, unknown> } | null;
    streamBuffer: string;
    streamMetadata: { mode?: 'search' | 'chat' | 'agent'; agentName?: string; nodeId?: string } | null;
}

// Setup the machine with typings
export const chatMachine = setup({
    types: {
        context: {} as ChatContext,
        events: {} as ChatEvent,
    },
    actions: {
        clearError: ({ context: _context }) => {
            // In a real implementation we would emit an assignment here
        },
        appendChunk: ({ context, event }) => {
            if (event.type !== 'RECV_CHUNK') return;
            context.streamBuffer += event.payload;
            if (event.metadata) {
                context.streamMetadata = event.metadata;
            }

            // Delegate flush via event
            chatActor.send({ type: 'FLUSH_BUFFER' });
        },
        flushToStore: ({ context }) => {
            if (!context.streamBuffer) return;
            const store = useChatStore.getState();
            const messages = [...store.messages];
            const lastMessage = messages[messages.length - 1];
            const metadata = context.streamMetadata;
            const isThinking = metadata?.nodeId === "thinking";

            if (lastMessage?.role === "assistant" && !lastMessage.isComplete) {
                // Determine if we need to switch from a pre-existing message or append directly
                const switchingNodes = metadata && lastMessage.nodeId && metadata.nodeId !== lastMessage.nodeId;

                if (switchingNodes && !isThinking && lastMessage.nodeId === "thinking") {
                    // Transitioning Thinking -> Answer, close thinking and start answer
                    messages[messages.length - 1] = { ...lastMessage, isComplete: true };
                    messages.push({
                        id: Date.now().toString(),
                        role: "assistant",
                        content: context.streamBuffer,
                        thinking: undefined,
                        timestamp: new Date(),
                        isComplete: false,
                        ...metadata
                    });
                } else {
                    messages[messages.length - 1] = {
                        ...lastMessage,
                        content: isThinking ? lastMessage.content : lastMessage.content + context.streamBuffer,
                        thinking: isThinking ? (lastMessage.thinking || "") + context.streamBuffer : lastMessage.thinking,
                        mode: metadata?.mode || lastMessage.mode,
                        agentName: metadata?.agentName || lastMessage.agentName,
                        nodeId: metadata?.nodeId || lastMessage.nodeId,
                    };
                }
            } else {
                messages.push({
                    id: Date.now().toString(),
                    role: "assistant",
                    content: isThinking ? "" : context.streamBuffer,
                    thinking: isThinking ? context.streamBuffer : undefined,
                    timestamp: new Date(),
                    isComplete: false,
                    ...metadata,
                });
            }

            store.setMessages(messages);
            context.streamBuffer = '';
            // We do NOT clear metadata here, we keep it for subsequent chunks
        },
        finalizeStoreStream: ({ context }) => {
            chatActor.send({ type: 'FLUSH_BUFFER' });
            // Defer marking complete to ensure flush finishes
            setTimeout(() => {
                const store = useChatStore.getState();
                const messages = [...store.messages];
                const lastMessage = messages[messages.length - 1];
                if (lastMessage?.role === "assistant") {
                    messages[messages.length - 1] = { ...lastMessage, isComplete: true };
                    store.setMessages(messages);
                }
            }, 0);
            context.streamBuffer = '';
            context.streamMetadata = null;
        }
    },
}).createMachine({
    id: 'chat',
    initial: 'idle',
    context: {
        currentMessage: '',
        errorMessage: null,
        pendingTool: null,
        streamBuffer: '',
        streamMetadata: null,
    },
    states: {
        idle: {
            on: {
                SEND_MESSAGE: {
                    target: 'generating', // Maps to the older "thinking/streaming" phase umbrella
                    guard: ({ event }) => event.payload.trim().length > 0
                },
            },
        },
        generating: {
            // In generating, we might be thinking, streaming, or calling a tool
            initial: 'thinking',
            states: {
                thinking: {
                    on: {
                        RECV_CHUNK: {
                            target: 'streaming',
                            actions: ['appendChunk']
                        },
                        TOOL_CALL: {
                            target: 'tool_confirm',
                            actions: () => {
                                // Here we would use xstate's assign in a real app, keeping it symbolic for structural setup first
                            }
                        },
                        DONE: {
                            target: '#chat.idle',
                            actions: ['finalizeStoreStream']
                        },
                        FLUSH_BUFFER: {
                            actions: ['flushToStore']
                        },
                        ERROR: '#chat.error',
                    }
                },
                streaming: {
                    on: {
                        RECV_CHUNK: {
                            target: 'streaming',
                            actions: ['appendChunk']
                        },
                        DONE: {
                            target: '#chat.idle',
                            actions: ['finalizeStoreStream']
                        },
                        FLUSH_BUFFER: {
                            actions: ['flushToStore']
                        },
                        ERROR: '#chat.error',
                    }
                },
                tool_confirm: {
                    on: {
                        CONFIRM_TOOL: 'thinking', // Go back to thinking after sending tool response
                        CANCEL_TOOL: '#chat.idle',
                        ERROR: '#chat.error',
                    }
                }
            }
        },
        error: {
            on: {
                RESET: 'idle',
                SEND_MESSAGE: 'generating', // Allow retry
            },
        },
    },
    on: {
        RESET: '.idle', // Global reset
    }
});

export const chatActor = createActor(chatMachine);
chatActor.start();
