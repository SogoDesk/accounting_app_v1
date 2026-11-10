export const generateClientCode = (clientName = "") => {
  const cleaned = String(clientName)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!cleaned) return "";

  let prefix = "CLI";

  if (cleaned.length >= 3) prefix = cleaned.slice(0, 3);
  else if (cleaned.length === 2) prefix = `${cleaned}C`;
  else if (cleaned.length === 1) prefix = `${cleaned}LI`;

  return `${prefix}-0001`;
};
