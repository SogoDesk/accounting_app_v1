const pool = require("../config/db");

const getNotifications = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
      [req.user.id],
    );

    const unread = result.rows.filter((n) => !n.is_read).length;

    return res.json({
      success: true,
      data: result.rows,
      unread_count: unread,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const markAllRead = async (req, res) => {
  try {
    await pool.query("UPDATE notifications SET is_read=true WHERE user_id=$1", [
      req.user.id,
    ]);
    return res.json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const createNotification = async ({
  user_id,
  title,
  message,
  type = "INFO",
  entity_type,
  entity_id,
}) => {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id,title,message,type,entity_type,entity_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user_id, title, message, type, entity_type || null, entity_id || null],
    );
  } catch (err) {
    console.error("createNotification error:", err.message);
  }
};

module.exports = {
  getNotifications,
  markAllRead,
  createNotification,
};
