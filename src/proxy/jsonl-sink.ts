import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Append-only JSONL writer. One event per line, terminated with `\n`.
 *
 * Per ARCHITECTURE.md § JSONL record format: "the file IS the API."
 * No buffering beyond Node's default stream buffer; rely on the OS to
 * flush. On `close()` we await the drain.
 */
export class JsonlSink {
  private stream: WriteStream | null = null;
  private path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.stream = createWriteStream(this.path, { flags: "a", encoding: "utf8" });
    await new Promise<void>((resolveOpen, reject) => {
      this.stream!.once("open", () => resolveOpen());
      this.stream!.once("error", reject);
    });
  }

  /** Append one JSON-serialised event followed by a newline. */
  append(event: unknown): void {
    if (!this.stream) throw new Error("JsonlSink: open() must be called before append()");
    this.stream.write(JSON.stringify(event) + "\n");
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolveClose, reject) => {
      s.end((err: Error | null | undefined) => (err ? reject(err) : resolveClose()));
    });
  }

  /** Absolute path of the log file. */
  get filePath(): string {
    return this.path;
  }
}
