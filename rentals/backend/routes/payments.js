const express = require("express");
const db = require("../db/connection");
const { logFailure } = require("../utils/safeLog");

const router = express.Router();

function legacyPayment(row) {
  return {
    PaymentID: row.paymentid,
    RentID: row.rentid,
    Amount: row.amount,
    Status: row.status,
    PaymentReference: row.paymentreference,
    PaidAt: row.paidat,
    CreatedAt: row.createdat
  };
}

// Compatibility route for the original class-project view.
router.get("/", async (_req, res) => {
  try {
    const result = await db.query("SELECT * FROM paymentdetails");
    res.json(result.rows.map(legacyPayment));
  } catch (error) {
    logFailure("payments.list", error);
    res.status(500).json({ error: "Failed to load legacy payment records" });
  }
});

module.exports = router;
