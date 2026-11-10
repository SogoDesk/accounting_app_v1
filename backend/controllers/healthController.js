const pool = require("../config/db");

const dbHealthCheck = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT NOW() AS server_time");
    return res.status(200).json({
      success: true,
      message: "Database connected",
      data: result.rows[0],
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = { dbHealthCheck };
