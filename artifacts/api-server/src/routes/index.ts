import { Router, type IRouter } from "express";
import healthRouter from "./health";
import feedHealthRouter from "./feed-health";
import internalRouter from "./internal";
import localExportRouter from "./local-export";
import webhooksRouter from "./webhooks";
import recommendationsRouter from "./recommendations";
import feedsRouter from "./feeds";
import {
  authRouter,
  overviewRouter,
  runsRouter,
  productsRouter,
  googleRouter,
  metaRouter,
  imagesRouter,
  inventoryRouter,
  qualityRouter,
} from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(feedHealthRouter);
router.use(feedsRouter);
router.use("/internal", internalRouter);
router.use("/local", localExportRouter);
router.use("/webhooks", webhooksRouter);
router.use("/recommendations", recommendationsRouter);

// Dashboard routes
router.use(authRouter);
router.use(overviewRouter);
router.use(runsRouter);
router.use(productsRouter);
router.use(googleRouter);
router.use(metaRouter);
router.use(imagesRouter);
router.use(inventoryRouter);
router.use(qualityRouter);

export default router;
