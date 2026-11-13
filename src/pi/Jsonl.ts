import { StringDecoder } from 'node:string_decoder';

/**
 * Strict JSONL framing: split on LF (0x0A) only, strip one optional CR,
 * decode UTF-8 across chunk boundaries. Never use node:readline — it also
 * splits on U+2028/U+2029, both legal inside JSON strings. (§4.2, Pi jsonl.js)
 */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf('\n', start);
      if (nl < 0) break;
      let line = this.buffer.slice(start, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
      start = nl + 1;
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return lines;
  }

  /** Emit a trailing unterminated line, as Pi's own jsonl.js does. */
  end(): string[] {
    const rest = this.buffer + this.decoder.end();
    this.buffer = '';
    return rest.length ? [rest.endsWith('\r') ? rest.slice(0, -1) : rest] : [];
  }
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
