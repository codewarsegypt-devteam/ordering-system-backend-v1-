import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import * as authController from "../controllers/auth.controller.js";

const router = Router();

router.post("/signup", asyncHandler(authController.signup));
router.get("/verify-email", asyncHandler(authController.verifyEmail));

router.post("/login", asyncHandler(authController.login));
router.post("/resend-verification", asyncHandler(authController.resendVerification));

router.post("/forgot-password", asyncHandler(authController.forgotPassword));
router.get("/reset-password", asyncHandler(authController.resetPasswordPage));
router.post("/reset-password", asyncHandler(authController.resetPassword));

router.post("/logout", requireAuth, authController.logout);
router.get("/me", requireAuth, authController.me);
router.post("/register", asyncHandler(authController.register));

export default router;
