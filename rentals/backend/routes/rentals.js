const express = require("express");
const db = require("../db/connection");
const { logFailure } = require("../utils/safeLog");

const router = express.Router();

function legacyRental(row) {
  return {
    RentID: row.rentid,
    RentDate: row.rentdate,
    ReturnDate: row.returndate,
    CustID: row.custid,
    CarID: row.carid,
    FName: row.fname,
    LName: row.lname,
    Email: row.email,
    Make: row.make,
    Model: row.model,
    Year: row.year,
    Status: row.status
  };
}

router.get("/", async (_req, res) => {
  try {
    const result = await db.query("SELECT * FROM rentaldetails");
    res.json(result.rows.map(legacyRental));
  } catch (error) {
    logFailure("rentals.list", error);
    res.status(500).json({
      error: "Failed to load legacy rental records. If you are using the new MVP schema, use /api/reservations instead."
    });
  }
});

router.post("/", async (req, res) => {
  const { RentDate, ReturnDate, CustID, CarID } = req.body;
  if (!RentDate || !ReturnDate || !CustID || !CarID) {
    return res.status(400).json({ error: "All rental fields are required" });
  }

  const client = await db.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query(
      `INSERT INTO rental (rentdate, returndate, custid, carid)
       VALUES ($1, $2, $3, $4)
       RETURNING rentid`,
      [RentDate, ReturnDate, CustID, CarID]
    );
    await client.query("UPDATE cars SET status = 'Rented' WHERE carid = $1", [CarID]);
    await client.query("COMMIT");
    transactionStarted = false;
    res.status(201).json({ message: "Rental created successfully", RentID: result.rows[0].rentid });
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    logFailure("rentals.create", error);
    res.status(500).json({ error: "Rental creation failed" });
  } finally {
    client.release();
  }
});

module.exports = router;
