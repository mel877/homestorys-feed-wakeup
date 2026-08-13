import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { loadConfig } from "./config";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// Raw body parser for webhook HMAC validation (must come before json parser)
app.use("/api/webhooks", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Load and validate config eagerly at startup — fail fast if config is invalid
try {
  const config = loadConfig();
  const marketCount = Object.keys(config.markets.markets).length;
  const languageCount = config.languages.languages.length;
  logger.info(
    { markets: marketCount, languages: languageCount },
    "Config loaded",
  );
} catch (err) {
  logger.error({ err }, "Fatal: config validation failed at startup");
  process.exit(1);
}

// Require SHOPIFY_WEBHOOK_SECRET in non-development environments
const _appEnv = process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "production";
if (_appEnv !== "development" && _appEnv !== "test") {
  if (!process.env["SHOPIFY_WEBHOOK_SECRET"]) {
    logger.warn(
      "SHOPIFY_WEBHOOK_SECRET is not set — webhook endpoint will reject all requests. " +
      "Set this secret in deployment environment variables before enabling Shopify webhooks.",
    );
  }
}

export default app;
