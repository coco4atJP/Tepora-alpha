const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3001/ws');

ws.on('open', function open() {
    console.log('Connected to WebSocket server');

    // Send connection message
    ws.send(JSON.stringify({
        type: "connect",
        session_id: "test-session",
        active_agent: "null",
        agent_mode: "null"
    }));

    // Send a message with thinking budget 2
    setTimeout(() => {
        console.log('Sending message to trigger parallel thinking...');
        ws.send(JSON.stringify({
            message: "Explain the concept of quantum superposition in simple terms.",
            mode: "chat",
            thinkingBudget: 2
        }));
    }, 1000); // Wait for connection sequence to complete
});

ws.on('message', function incoming(data) {
    const msg = JSON.parse(data.toString());

    if (msg.type === "activity") {
        console.log(`[Activity] ${msg.data.status}: ${msg.data.message}`);
    } else if (msg.type === "thought") {
        console.log(`\n\n[Thought Process Received]`);
        console.log('=============================================');
        console.log(msg.content.substring(0, 500) + '...');
        console.log('=============================================\n\n');
    } else if (msg.type === "chunk") {
        process.stdout.write(msg.message);
    } else if (msg.type === "done") {
        console.log('\n\n[Stream Complete]');
        process.exit(0);
    } else if (msg.type === "error") {
        console.error(`[Error] ${msg.message}`);
        process.exit(1);
    }
});

ws.on('error', function error(err) {
    console.error('[WebSocket Error]', err);
    process.exit(1);
});
