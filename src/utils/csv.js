/**
 * CSV building (SPEC-P4 §7): the existing formula guard, RFC 4180 quoting,
 * a UTF-8 BOM and CRLF line ends.
 */

/** The UTF-8 byte order mark (U+FEFF), so spreadsheet programs read UTF-8. */
export const BOM = String.fromCharCode(0xfeff);

/**
 * The formula guard kept from v1.1.0: a value that starts with `= + - @`
 * (after leading spaces), a tab or a CR is prefixed with `'`.
 * @param {any} value - Cell value
 * @returns {string}
 */
export const guardCell = (value) => {
  const s = value === undefined || value === null ? '' : String(value);
  if (/^[\t\r]/.test(s) || /^[=+\-@]/.test(s.trimStart())) return `'${s}`;
  return s;
};

/**
 * One RFC 4180 cell: always quoted, inner quotes doubled.
 * @param {any} value - Cell value
 * @returns {string}
 */
export const csvCell = (value) => `"${guardCell(value).replace(/"/g, '""')}"`;

/**
 * Build a CSV document.
 * @param {Array<Array<any>>} rows - Rows (the first is the header)
 * @returns {string} - BOM + CRLF-separated rows
 */
export const buildCsv = (rows) => `${BOM}${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;

export default buildCsv;
