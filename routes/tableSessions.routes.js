import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAuth, requireMerchant, requireStaff } from "../middleware/auth.js";
import * as tableSessionsController from "../controllers/tableSessions.controller.js";

const router = Router();

// Public endpoint by QR token (customer side)
router.get("/active", asyncHandler(tableSessionsController.getActiveByToken));

// Staff endpoints
router.get(
  "/",
  requireAuth,
  requireMerchant,
  requireStaff,
  asyncHandler(tableSessionsController.listAllSessions),
);
router.get(
  "/open",
  requireAuth,
  requireMerchant,
  requireStaff,
  asyncHandler(tableSessionsController.listOpenSessions),
);
router.get(
  "/:sessionId/orders",
  requireAuth,
  requireMerchant,
  requireStaff,
  asyncHandler(tableSessionsController.getSessionOrders),
);
router.patch(
  "/:sessionId/close",
  requireAuth,
  requireMerchant,
  requireStaff,
  asyncHandler(tableSessionsController.closeSession),
);

export default router;
