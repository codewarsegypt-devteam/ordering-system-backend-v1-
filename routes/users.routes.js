import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  requireAuth,
  requireMerchant,
  requireCanManageUsers,
} from "../middleware/auth.js";
import * as usersController from "../controllers/users.controller.js";

const router = Router();
router.use(requireAuth);
router.use(requireMerchant);
router.use(requireCanManageUsers);

router.post("/", asyncHandler(usersController.create));
router.get("/", asyncHandler(usersController.list));
router.get("/:userId", asyncHandler(usersController.getOne));
router.patch("/:userId", asyncHandler(usersController.update));
router.patch("/:userId/status", asyncHandler(usersController.updateStatus));
router.patch("/:userId/password", asyncHandler(usersController.updatePassword));
router.patch("/:userId/branch", asyncHandler(usersController.updateBranch));
router.delete("/:userId", asyncHandler(usersController.remove));

export default router;
 