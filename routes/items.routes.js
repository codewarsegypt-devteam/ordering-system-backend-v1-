import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireMerchant,
  requireCanEditMenu,
  requireStaff
} from "../middleware/auth.js";
import * as itemsController from "../controllers/items.controller.js";

const router = Router();
router.use(requireAuth);
router.use(requireMerchant);
// router.use(requireCanEditMenu);

router.post(
  "/categories/:categoryId/items",
  asyncHandler(itemsController.create),
);
router.get(
  "/categories/:categoryId/items",
  requireStaff,
  asyncHandler(itemsController.listByCategory),
);
router.get("/items/:itemId", requireStaff, asyncHandler(itemsController.getOne));
router.patch("/items/:itemId", asyncHandler(itemsController.update));
router.patch(
  "/items/:itemId/status",
  asyncHandler(itemsController.updateStatus),
);
router.delete("/items/:itemId", asyncHandler(itemsController.remove));

export default router;
