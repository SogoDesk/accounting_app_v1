export const generateCandidateCode = (fullName = "") => {
  const words = String(fullName).trim().split(/\s+/).filter(Boolean);

  if (words.length >= 2) {
    const first = String(words[0])
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 1);
    const second = String(words[1])
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 2);
    const combined = `${first}${second}`;

    if (combined.length === 3) return `${combined}-0001`;
    if (combined.length === 2) return `${combined}C-0001`;
    if (combined.length === 1) return `${combined}AN-0001`;
  }

  const cleaned = String(fullName)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!cleaned) return "";

  let prefix = "CAN";
  if (cleaned.length >= 3) prefix = cleaned.slice(0, 3);
  else if (cleaned.length === 2) prefix = `${cleaned}C`;
  else if (cleaned.length === 1) prefix = `${cleaned}AN`;

  return `${prefix}-0001`;
};

// Timezone-safe local YYYY-MM-DD. A DATE column round-trips through JSON as a
// UTC ISO string (e.g. "2027-02-28T18:30:00Z" for 2027-03-01 in +05:30), so a
// naive slice(0,10) is off by a day in some zones. Plain YYYY-MM-DD is treated
// as a local date; a full ISO is converted to local before formatting.
export const toLocalYMD = (v) => {
  if (!v) return "";
  const s = String(v);
  const plain = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = plain
    ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]))
    : new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
};

// Credential expiry status for compliance dates (work auth, insurance).
// Returns null when no date; otherwise a badge descriptor + days remaining.
export const expiryTone = (dateStr) => {
  const ymd = toLocalYMD(dateStr);
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  if (days < 0) return { label: "Expired", cls: "badge-red", days };
  if (days <= 30) return { label: `${days}d left`, cls: "badge-yellow", days };
  return { label: "Valid", cls: "badge-green", days };
};
