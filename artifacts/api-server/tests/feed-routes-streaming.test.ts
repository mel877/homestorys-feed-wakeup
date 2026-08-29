import { once } from "events";
import http from "http";
import { PassThrough, Readable } from "stream";
import { gzipSync } from "zlib";
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
  mockDbSelect,
} = vi.hoisted(() => {
  const mockCreateReadStream = vi.fn();
  const mockDownload = vi.fn();
  const mockExists = vi.fn();
  const mockGetMetadata = vi.fn();
  const mockFile = vi.fn();
  const mockBucket = vi.fn();
  const mockDbSelect = vi.fn();
  return {
    mockCreateReadStream,
    mockDownload,
    mockExists,
    mockFile,
    mockGetMetadata,
    mockBucket,
    mockDbSelect,
  };
});

vi.mock("@google-cloud/storage", () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: mockBucket,
  })),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
  },
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
  ["/api/feeds/meta/base.csv", "feeds/meta/meta-base.csv", "text/csv"],
  ["/api/feeds/meta/lang/fr.csv", "feeds/meta/meta-language-fr.csv", "text/csv"],
  ["/api/feeds/meta/country/BE.csv", "feeds/meta/meta-country-BE.csv", "text/csv"],
  ["/api/feeds/google/fr.tsv", "feeds/google/google-fr.tsv", "text/tab-separated-values"],
  ["/api/feeds/google/de.tsv", "feeds/google/google-de.tsv", "text/tab-separated-values"],
  ["/api/feeds/google/showroom/eupen.tsv", "feeds/showroom/google-eupen.tsv", "text/tab-separated-values"],
  ["/api/feeds/meta/showroom/eupen.csv", "feeds/showroom/meta-eupen.csv", "text/csv"],
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
    mockDbSelect.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    }));
  });

  for (const [url, storagePath, contentType] of publicFeedCases) {
    it(`streams ${url} from App Storage without buffering`, async () => {
      const response = await request(app).get(url);

      expect(response.status).toBe(200);
      expect(response.text).toBe("large-feed");
      expect(response.headers["content-type"]).toContain(contentType);
      expect(response.headers["content-length"]).toBe("10");
      expect(response.headers["x-feed-size"]).toBe("10");
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.headers["content-disposition"]).toBe("inline");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(mockFile).toHaveBeenCalledWith(storagePath);
      expect(mockFile).toHaveBeenCalledWith(storagePath, {
        generation: "123456789",
      });
      expect(mockGetMetadata).toHaveBeenCalledOnce();
      expect(mockCreateReadStream).toHaveBeenCalledOnce();
      expect(mockDownload).not.toHaveBeenCalled();
    });
  }

  for (const userAgent of [
    "curl/8.14.1",
    "Mozilla/5.0",
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "facebookexternalhit/1.1",
  ]) {
    it(`serves the same public feed to ${userAgent}`, async () => {
      const response = await request(app)
        .get("/api/feeds/meta/fr.csv")
        .set("User-Agent", userAgent);

      expect(response.status).toBe(200);
      expect(response.text).toBe("large-feed");
      expect(response.headers["content-length"]).toBe("10");
    });
  }

  it("supports anonymous HEAD requests with the same metadata and no body", async () => {
    const response = await request(app).head("/api/feeds/google/fr.tsv");

    expect(response.status).toBe(200);
    expect(response.text).toBeUndefined();
    expect(response.headers["content-type"]).toContain("text/tab-separated-values");
    expect(response.headers["content-length"]).toBe("10");
    expect(response.headers["x-feed-size"]).toBe("10");
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });

  it("serves a precompressed derivative for large feeds with a known transfer size", async () => {
    const rawSize = 64 * 1024 * 1024;
    const compressedBody = gzipSync(Buffer.from("large-feed"));
    mockFile.mockImplementation((path: string, options?: { generation?: string }) => ({
      createReadStream: vi.fn((streamOptions?: { decompress?: boolean }) => {
        expect(path).toBe("feeds/google/google-fr.tsv.gz");
        expect(options).toEqual({ generation: "gzip-generation" });
        expect(streamOptions).toEqual({ decompress: false });
        return Readable.from([compressedBody]);
      }),
      download: mockDownload,
      exists: mockExists,
      getMetadata: vi.fn().mockResolvedValue([path.endsWith(".gz")
        ? { size: String(compressedBody.length), generation: "gzip-generation" }
        : { size: String(rawSize), generation: "raw-generation" }]),
    }));

    const response = await request(app).get("/api/feeds/google/fr.tsv");

    expect(response.status).toBe(200);
    expect(response.text).toBe("large-feed");
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-length"]).toBe(String(compressedBody.length));
    expect(response.headers["x-feed-size"]).toBe(String(rawSize));
    expect(response.headers["x-feed-compressed-size"]).toBe(String(compressedBody.length));
    expect(response.headers["vary"]).toContain("Accept-Encoding");
  });

  it("falls back to the deterministic current path when snapshot metadata is missing", async () => {
    const response = await request(app).get("/api/feeds/google/market/BE_FR.tsv");

    expect(response.status).toBe(200);
    expect(response.text).toBe("large-feed");
    expect(mockFile).toHaveBeenCalledWith("feeds/google/google-fr-BE_FR.tsv");
  });

  it("keeps serving the deterministic current path when the snapshot database is unavailable", async () => {
    mockDbSelect.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockRejectedValue(new Error("database unavailable")),
        })),
      })),
    }));

    const response = await request(app).get("/api/feeds/google/market/BE_FR.tsv");

    expect(response.status).toBe(200);
    expect(response.text).toBe("large-feed");
    expect(mockFile).toHaveBeenCalledWith("feeds/google/google-fr-BE_FR.tsv");
  });

  it("returns 404 before opening a stream when the feed does not exist", async () => {
    mockGetMetadata.mockRejectedValue(
      Object.assign(new Error("No such object"), { code: 404 }),
    );

    const response = await request(app).get("/api/feeds/meta/fr.csv");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: "Feed file not found",
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