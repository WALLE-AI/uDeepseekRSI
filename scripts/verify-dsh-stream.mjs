import WebSocket from 'ws';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) throw new Error('Usage: node scripts/verify-dsh-stream.mjs <port>');

const baseUrl = `http://127.0.0.1:${port}`;
const createdAt = Date.now();
const createdResponse = await fetch(`${baseUrl}/api/conversations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Streaming verification', extra: {} }),
});
const created = await createdResponse.json();
if (!createdResponse.ok) throw new Error(`Create failed: ${JSON.stringify(created)}`);
const conversationId = created.data.id;
const chunks = [];
let finishedAt;

try {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const finished = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Streaming verification timed out.')), 120_000);
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      const matchesConversation =
        event.data?.conversation_id === conversationId || event.data?.session_id === conversationId;
      if (!matchesConversation) return;
      if (event.name === 'message.stream' && event.data.type === 'text') {
        chunks.push({ at: Date.now(), text: String(event.data.data ?? '') });
      }
      if (event.name === 'turn.completed') {
        clearTimeout(timeout);
        finishedAt = Date.now();
        resolve();
      }
    });
  });

  const sentAt = Date.now();
  const sendResponse = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '不要调用工具。请用中文连续写一篇至少六百字的技术短文，分成六段，只输出正文。',
    }),
  });
  if (!sendResponse.ok) throw new Error(`Send failed: ${await sendResponse.text()}`);
  await finished;
  socket.close();

  const totalText = chunks.map((chunk) => chunk.text).join('');
  const firstChunkMs = chunks.length > 0 ? chunks[0].at - sentAt : null;
  const streamSpanMs = chunks.length > 1 ? chunks.at(-1).at - chunks[0].at : 0;
  console.log(
    JSON.stringify({
      conversationId,
      chunkCount: chunks.length,
      textLength: totalText.length,
      firstChunkMs,
      streamSpanMs,
      completedMs: finishedAt - sentAt,
      completedAfterFirstChunkMs: chunks.length > 0 ? finishedAt - chunks[0].at : null,
    })
  );
  if (chunks.length < 2 || streamSpanMs <= 0 || finishedAt <= chunks[0].at) {
    throw new Error('Response was not delivered as observable incremental chunks.');
  }
} finally {
  await fetch(`${baseUrl}/api/conversations/${conversationId}`, { method: 'DELETE' }).catch(() => undefined);
}
