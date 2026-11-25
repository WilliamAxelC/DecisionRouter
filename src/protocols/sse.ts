export interface ParsedSseEvent {
  event?: string;
  data: string;
}

/**
 * Incrementally parses a Server-Sent Events (SSE) byte stream into `{ event, data }` frames.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseBlock = (block: string): ParsedSseEvent | null => {
    const lines = block.split(/\r?\n/);
    let eventName: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line === "" || line.startsWith(":")) continue;
      const colonIdx = line.indexOf(":");
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") {
        eventName = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (dataLines.length === 0 && !eventName) return null;
    return {
      event: eventName,
      data: dataLines.join("\n"),
    };
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match: RegExpExecArray | null;
      const sepRegex = /\r?\n\r?\n/;
      while ((match = sepRegex.exec(buffer)) !== null) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseBlock(block);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const parsed = parseBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

export function safeJsonParse<T = Record<string, unknown>>(
  raw: string,
  fallback: T,
): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
