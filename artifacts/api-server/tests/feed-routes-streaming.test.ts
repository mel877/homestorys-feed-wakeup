import { once } from "events";
import http from "http";
import { PassThrough, Readable } from "stream";
import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateReadStream,
  mockDownload,
  mockExists,
  mockFile,
  mockGetMetadata,
  mockBucket,
} = vi.hoisted(() => {
  const mockCreateReadStream = vi.fn();
  const mockDownload = vi.fn();
  const mockExists = vi.fn();
  const mockGetMetadata = vi.fn();
  const mockFile = vi.fn();
  const mockBucket = vi.fn();
  return {
    mockCreateReadStream,
    mockDownload,
    mockExists,
    mockFile,
    mockGetMetadata,
    mockBucket,
  };
});

vi.mock("@google-cloud/storage", () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: mockBucket,
  })),
}));

vi.mock("@workspace/db", () => ({
  db: {},
  feedSnapshotsTable: {},
}));

process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] = "test-bucket";

import feedsRouter from "../src/routes/feeds";

function buildApp(): Express {
  const app = express();
  app.use("/api", feedsRouter);
  return app;
}

const publicFeedCases = [
  ["/api/feeds/meta/fr.csv", "feeds/meta/meta-fr.csv", "text/csv"],
  ["/api/feeds/meta/de.csv", "feeds/meta/meta-de.csv", "text/csv"],
  ["/api/feeds/google/fr.tsv", "feeds/google/google-fr.tsv", "text/tab-separated-values"],
  ["/api/feeds/google/de.tsv", "feeds/google/google-de.tsv", "text/tab-separated-values"],
] as const;

describe("public feed streaming", () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    mockFile.mockReturnValue({
      createReadStream: mockCreateReadStream,
      download: mockDownload,
      exists: mockExists,
      getMetadata: mockGetMetadata,
    });
    mockBucket.mockReturnValue({ file: mockFile });
    mockExists.mockResolvedValue([true]);
    mockDownload.mockResolvedValue([Buffer.from("buffered-response")]);
    mockGetMetadata.mockResolvedValue([{ size: "10", generation: "123456789" }]);
    mockCreateReadStream.mockImplementation(() =>
      Readable.from([Buffer.from("large-"), Buffer.from("feed")]),
    );
  });

  for (const [url, storagePath, contentType] of publicFeedCases) {
    it(`streams ${url} from App Storage without buffering`, async () => {
      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.text).toBe("large-feed");
      expect(response.headers["content-type"]).toContain(contentType);
      expect(response.headers["content-length"]).toBe("10");
      expect(mockFile).toHaveBeenCalledWith(storagePath);
      expect(mockFile).toHaveBeenCalledWith(storagePath, {
        generation: "123456789",
      });
      expect(mockGetMetadata).toHaveBeenCalledOnce();
      expect(mockCreateReadStream).toHaveBeenCalledOnce();
      expect(mockDownload).not.toHaveBeenCalled();
    });
  }

  it("returns 404 before opening a stream when the feed does not exist", async () => {
    mockGetMetadata.mockRejectedValue(
      Object.assign(new Error("No such object"), { code: 404 }),
    );

    const response = await request(app).get("/api/feeds/meta/fr.csv");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: "Feed file not found",
      storagePath: "feeds/meta/meta-fr.csv",
    });
    expect(mockCreateReadStream).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when App Storage cannot open the feed", async () => {
    mockGetMetadata.mockRejectedValue(new Error("storage unavailable"));

    const response = await request(app).get("/api/feeds/google/fr.tsv");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Feed temporarily unavailable",
    });
    expect(response.headers["retry-after"]).toBe("60");
    expect(mockCreateReadStream).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when the source stream fails before sending data", async () => {
    mockCreateReadStream.mockImplementation(() => {
      const stream = new Readable({
        read() {
          queueMicrotask(() => {
            this.destroy(new Error("read failed"));
          });
        },
      });
      return stream;
    });

    const outcome = await request(app)
      .get("/api/feeds/meta/fr.csv")
      .then(
        (response) => ({ status: response.status, body: response.body }),
        (error: unknown) => ({ error }),
      );

    expect(outcome).toMatchObject({
      status: 503,
      body: { error: "Feed temporarily unavailable" },
    });
  });

  it("destroys the source if the client disconnects while metadata is loading", async () => {
    let resolveMetadata!: (value: [{ size: string; generation: string }]) => void;
    mockGetMetadata.mockReturnValue(
      new Promise((resolve) => {
        resolveMetadata = resolve;
      }),
    );
    const source = new PassThrough();
    mockCreateReadStream.mockReturnValue(source);
    const server = app.listen(0);

    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not expose a TCP port");
      }

      const clientRequest = http.get(
        `http://127.0.0.1:${address.port}/api/feeds/meta/fr.csv`,
      );
      clientRequest.on("error", () => undefined);
      await once(clientRequest, "socket");
      await vi.waitFor(() => {
        expect(mockGetMetadata).toHaveBeenCalledOnce();
      });
      const clientClosed = new Promise<void>((resolve) => {
        clientRequest.once("close", () => resolve());
      });
      clientRequest.destroy();
      await clientClosed;

      resolveMetadata([{ size: "10", generation: "123456789" }]);

      await vi.waitFor(() => {
        expect(mockCreateReadStream).toHaveBeenCalledOnce();
        expect(source.destroyed).toBe(true);
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});