import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAuth, requireMerchant, requireWaiter } from "../middleware/auth.js";
import * as waiterController from "../controllers/waiter.controller.js";

const router = Router();
router.use(requireAuth);
router.use(requireMerchant);
router.use(requireWaiter);

router.get("/orders/ready", asyncHandler(waiterController.listReadyOrders));
router.get(
  "/orders/:orderId/items",
  asyncHandler(waiterController.getOrderItems),
);
router.patch(
  "/orders/:orderId/complete",
  asyncHandler(waiterController.completeReadyOrder),
);

export default router;
