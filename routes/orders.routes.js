import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireStaff,
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
