const GMT_PLUS_3_OFFSET_MINUTES = 3 * 60;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pad3(value) {
  return String(value).padStart(3, "0");
}

function formatIsoWithOffset(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hours = pad2(shifted.getUTCHours());
  const minutes = pad2(shifted.getUTCMinutes());
  const seconds = pad2(shifted.getUTCSeconds());
  const millis = pad3(shifted.getUTCMilliseconds());

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = pad2(Math.floor(absOffset / 60));
  const offsetMins = pad2(absOffset % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetMins}`;
}

export function toGmtPlus3Iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return formatIsoWithOffset(date, GMT_PLUS_3_OFFSET_MINUTES);
}

export function nowGmtPlus3Iso() {
  return formatIsoWithOffset(new Date(), GMT_PLUS_3_OFFSET_MINUTES);
}
