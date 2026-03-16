import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import * as publicController from "../controllers/public.controller.js";
import * as tableServicesController from "../controllers/tableServices.controller.js";
const router = Router();

router.get("/scan", asyncHandler(publicController.getScan));
router.get("/menu/:menuId", asyncHandler(publicController.getMenuById));
// router.get("/menu", asyncHandler(publicController.getMenu));
router.post("/cart/validate", asyncHandler(publicController.validateCart));
router.get(
  "/table/:tableId/qrcode",
  asyncHandler(publicController.getTableQrcodeByTableId),
);
router.post("/create-order", asyncHandler(publicController.createOrder));
router.post(
  "/table-services",
  asyncHandler(tableServicesController.createFromToken),
);
router.post("/create-owner-user", asyncHandler(publicController.createOwnerUser));
export default router;
