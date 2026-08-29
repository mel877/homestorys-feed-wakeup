import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assembleVersionedFeed,
  deterministicFeedPartPath,
  serializeFeedPart,
} from "../src/exporters/durable-feed-parts";

describe("durable feed parts", () => {
  it("reuses the same object path and bytes when a batch is retried", () => {
    const rows = [{ id: "b", title: "B" }, { id: "a", title: "A" }];
    expect(deterministicFeedPartPath("feeds/google/versions/v1/feed.tsv", 7))
      .toBe("feeds/google/versions/v1/feed.tsv.parts/000007.jsonl");
    expect(serializeFeedPart(rows)).toBe(
      '{"id":"a","title":"A"}\n{"id":"b","title":"B"}\n',
    );
  });

  it("refuses finalization while a required part is missing", async () => {
    await expect(assembleVersionedFeed({
      outputPath: "versions/v1/feed.tsv",
      headers: ["id", "title"],
      delimiter: "\t",
      requiredBatchIndexes: [0, 1],
      parts: [{ batchIndex: 0, artifactPath: "part-0", status: "completed" }],
      storage: memoryStorage({ "part-0": '{"id":"a","title":"A"}\n' }),
    })).rejects.toThrow("Feed finalization barrier is closed");
  });

  it("assembles completed parts in batch order without duplicating headers", async () => {
    const storage = memoryStorage({
      "part-1": '{"id":"b","title":"B"}\n',
      "part-0": '{"id":"a","title":"A"}\n',
    });
    const result = await assembleVersionedFeed({
      outputPath: "versions/v1/feed.tsv",
      headers: ["id", "title"],
      delimiter: "\t",
      requiredBatchIndexes: [0, 1],
      parts: [
        { batchIndex: 1, artifactPath: "part-1", status: "completed" },
        { batchIndex: 0, artifactPath: "part-0", status: "completed" },
      ],
      storage,
    });

    expect(storage.output()).toBe("id\ttitle\na\tA\nb\tB\n");
    expect(result.itemCount).toBe(2);
  });
});

function memoryStorage(files: Record<string, string>) {
  const chunks: Buffer[] = [];
  return {
    openPart: async (path: string) => {
      const content = files[path];
      return content === undefined ? null : Readable.from([content]);
    },
    createOutput: () => {
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      return {
        stream,
        done: new Promise<{ sha256: string; bytes: number }>((resolve) => {
          stream.on("finish", () => resolve({
            sha256: "test-sha",
            bytes: Buffer.concat(chunks).length,
          }));
        }),
      };
    },
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}