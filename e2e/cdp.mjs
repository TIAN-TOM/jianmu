// 最小的 DevTools 协议客户端：走 --remote-debugging-pipe，本机不多开调试端口。
// Chrome 从 fd 3 读命令、往 fd 4 写回复，每条消息是以 \0 结尾的 JSON。
export function createCdp(writable, readable) {
  let nextId = 1;
  let buffered = [];
  const pending = new Map();
  const listeners = new Set();

  readable.on("data", (chunk) => {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      buffered.push(chunk.subarray(start, end));
      const message = JSON.parse(Buffer.concat(buffered).toString("utf8"));
      buffered = [];
      start = end + 1;
      const waiting = pending.get(message.id);
      if (waiting) {
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(`${waiting.method} 失败：${message.error.message}`));
        else waiting.resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    }
    if (start < chunk.length) buffered.push(chunk.subarray(start));
  });

  function send(method, params = {}, sessionId, timeoutMs = 15_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 等了 ${timeoutMs} 毫秒没有回复`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      writable.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  return { send, on: (listener) => listeners.add(listener) };
}
