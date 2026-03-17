import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAuth, requireMerchant, requireOwner } from "../middleware/auth.js";
import * as currenciesController from "../controllers/currencies.controller.js";

const router = Router();

// Public: list all available currencies (frontend needs this to show a currency picker)
router.get("/", asyncHandler(currenciesController.listGlobalCurrencies));

// Merchant currency management — owner only
router.use("/merchant", requireAuth, requireMerchant, requireOwner);
router.get("/merchant", asyncHandler(currenciesController.getMerchantCurrencySetup));
router.patch("/merchant/base", asyncHandler(currenciesController.setMerchantBaseCurrency));
router.post("/merchant/display", asyncHandler(currenciesController.addMerchantDisplayCurrency));
router.patch(
  "/merchant/display/:mcId",
  asyncHandler(currenciesController.updateMerchantDisplayCurrency),
);
router.delete(
  "/merchant/display/:mcId",
  asyncHandler(currenciesController.removeMerchantDisplayCurrency),
);

export default router;
