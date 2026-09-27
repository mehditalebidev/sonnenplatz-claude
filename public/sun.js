// Sun position (after Vladimir Agafonkin's SunCalc, BSD). Returns degrees:
// alt above the horizon (with refraction), az as a compass bearing (0 = north, 90 = east).
const RAD = Math.PI / 180, DAY_MS = 864e5, J1970 = 2440588, J2000 = 2451545, E = RAD * 23.4397;

export function sunPosition(ms, lat, lon) {
  const d = ms / DAY_MS - 0.5 + J1970 - J2000;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(E) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(E), Math.cos(L));
  const lw = RAD * -lon, phi = RAD * lat;
  const H = RAD * (280.16 + 360.9856235 * d) - lw - ra;
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  let alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  // atmospheric refraction (Sæmundsson), only matters close to the horizon
  const h = Math.max(alt, 0);
  alt += 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
  return { alt: alt / RAD, az: ((az / RAD + 180) % 360 + 360) % 360 };
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (az) => COMPASS[Math.round(az / 22.5) % 16];
