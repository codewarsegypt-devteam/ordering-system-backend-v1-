import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireMerchant,
  requireCanEditMenu,
  requireStaff,
} from "../middleware/auth.js";
import * as menusController from "../controllers/menus.controller.js";
import { uploadMenuImage as uploadMenuImageMw } from "../middleware/upload.js";

const router = Router();
router.use(requireAuth);
router.use(requireMerchant);
// router.use(requireCanEditMenu);

router.post("/", requireCanEditMenu, asyncHandler(menusController.create));
router.get("/", requireStaff, asyncHandler(menusController.list));
router.post(
  "/:menuId/categories",
  requireCanEditMenu,
  asyncHandler(menusController.createCategory),
);
router.get(
  "/:menuId/categories",
  requireStaff,
  asyncHandler(menusController.listCategories),
);
router.get(
  "/:menuId/categories/short",
  requireStaff,
  asyncHandler(menusController.listShortCategories),
);
router.patch(
  "/:menuId",
  requireCanEditMenu,
  asyncHandler(menusController.update),
);
router.delete(
  "/:menuId",
  requireCanEditMenu,
  asyncHandler(menusController.remove),
);

// Menu cover image: upload/update and delete
router.post(
  "/:menuId/image",
  requireCanEditMenu,
  uploadMenuImageMw,
  asyncHandler(menusController.uploadMenuImage),
);
router.delete(
  "/:menuId/image",
  requireCanEditMenu,
  asyncHandler(menusController.deleteMenuImage),
);

export default router;
