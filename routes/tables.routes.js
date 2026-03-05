import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireMerchant,
  requireCanEditBranches,
  requireStaff,
} from "../middleware/auth.js";
import * as tablesController from "../controllers/tables.controller.js";

const router = Router();
router.use(requireAuth);
router.use(requireMerchant);

router.patch(
  "/:tableId",
  requireCanEditBranches,
  asyncHandler(tablesController.update),
);
router.delete(
  "/:tableId",
  requireCanEditBranches,
  asyncHandler(tablesController.remove),
);
router.get("/:tableId/qr", requireStaff, asyncHandler(tablesController.getQr));
router.get("/:tableId/qrcode", requireStaff, asyncHandler(tablesController.getStoredQr));
export default router;
