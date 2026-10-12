const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../db/connection");
const { logFailure } = require("../utils/safeLog");

const router = express.Router();

router.post("/signup", async (req, res) => {
  const { FName, LName, PhoneNumber, Email, Password } = req.body;
  if (!FName || !LName || !PhoneNumber || !Email || !Password) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const passwordHash = await bcrypt.hash(Password, 10);
    const result = await db.query(
      `INSERT INTO customers (fname, lname, phonenumber, email, passwordhash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING custid`,
      [FName, LName, PhoneNumber, Email, passwordHash]
    );
    res.status(201).json({
      message: "Customer account created successfully",
      customer: { CustID: result.rows[0].custid, FName, LName, Email }
    });
  } catch (error) {
    logFailure("auth.signup", error);
    res.status(500).json({ error: "Customer signup failed" });
  }
});

router.post("/login", async (req, res) => {
  const { Email, Password } = req.body;
  if (!Email || !Password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const result = await db.query(
      "SELECT * FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [Email]
    );
    if (result.rowCount === 0) return res.status(401).json({ error: "Invalid email or password" });

    const customer = result.rows[0];
    if (!(await bcrypt.compare(Password, customer.passwordhash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({
      message: "Login successful",
      customer: {
        CustID: customer.custid,
        FName: customer.fname,
        LName: customer.lname,
        Email: customer.email
      }
    });
  } catch (error) {
    logFailure("auth.login", error);
    res.status(500).json({ error: "Customer login failed" });
  }
});

module.exports = router;
