import { Router, type IRouter } from "express";
import healthRouter from "./health";
import feedHealthRouter from "./feed-health";
import internalRouter from "./internal";
import webhooksRouter from "./webhooks";
import recommendationsRouter from "./recommendations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(feedHealthRouter);
router.use("/internal", internalRouter);
router.use("/webhooks", webhooksRouter);
router.use("/recommendations", recommendationsRouter);

export default router;
