import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireMerchant,
  requireCanEditMenu,
  requireStaff
} from "../middleware/auth.js";
import * as menusController from "../controllers/menus.controller.js";

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
router.get("/:menuId/categories", requireStaff, asyncHandler(menusController.listCategories));
router.patch("/:menuId", requireCanEditMenu, asyncHandler(menusController.update));
router.delete("/:menuId",requireCanEditMenu, asyncHandler(menusController.remove));

export default router;
