import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireMerchant,
  requireStaff,
} from "../middleware/auth.js";
import * as tableServicesController from "../controllers/tableServices.controller.js";

const router = Router();
router.use(requireAuth);
router.use(requireMerchant);
router.use(requireStaff);

router.get("/", asyncHandler(tableServicesController.list));
router.get("/updates", asyncHandler(tableServicesController.pollUpdates));
router.patch(
  "/:id/status",
  asyncHandler(tableServicesController.updateStatus),
);


export default router;
