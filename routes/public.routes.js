import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import * as publicController from "../controllers/public.controller.js";
import * as menusController from "../controllers/menus.controller.js";
const router = Router();

router.get("/scan", asyncHandler(publicController.getScan));
router.get("/menu/:menuId", asyncHandler(publicController.getMenuById));
router.get("/menu", asyncHandler(publicController.getMenu));
router.post("/cart/validate", asyncHandler(publicController.validateCart));
router.get(
  "/table/:tableId/qrcode",
  asyncHandler(publicController.getTableQrcodeByTableId),
);

export default router;
