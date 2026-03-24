import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireMerchant,
} from "../middleware/auth.js";
import * as ordersController from "../controllers/orders.controller.js";

const router = Router();

router.post("/", asyncHandler(ordersController.create));
router.get(
  "/",
  requireAuth,
  requireMerchant,
  // requireStaff,
  asyncHandler(ordersController.list),
);
router.get(
  "/export/excel",
  requireAuth,
  requireMerchant,
  asyncHandler(ordersController.exportOrdersExcel),
);
// Polling endpoint — MUST be declared before /:orderId so Express doesn't
// treat the literal string "updates" as an orderId parameter.
router.get(
  "/updates",
  requireAuth,
  requireMerchant,
  asyncHandler(ordersController.pollUpdates),
);
router.get(
  "/:orderId",
  requireAuth,
  requireMerchant,
  // requireStaff,
  asyncHandler(ordersController.getOne),
);
router.patch(
  "/:orderId/status",
  requireAuth,
  requireMerchant,
  // requireStaff,
  asyncHandler(ordersController.updateStatus),
);

export default router;
