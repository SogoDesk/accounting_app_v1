const buildCsv = (rows, columns) => {
  if (!rows.length) return columns.join(",") + "\n";
  const header = columns.join(",");
  const body = rows.map((row) =>
    columns.map((col) => {
      const val = row[col] === null || row[col] === undefined ? "" : String(row[col]);
      return `"${val.replace(/"/g, '""')}"`;
    }).join(",")
  ).join("\n");
  return header + "\n" + body;
};

const sendCsvResponse = (res, csv, filename) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
};

module.exports = { buildCsv, sendCsvResponse };
