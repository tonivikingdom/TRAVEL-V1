/** BD-09 -> GCJ-02 -> WGS84 numerical inverse. Approximate coordinate transform,
 * not GPS/user evidence; fails closed at regional coverage boundaries. */
export function baiduToWgs84(lat: number, lng: number) {
  const x = lng - 0.0065,
    y = lat - 0.006,
    z = Math.hypot(x, y) - 0.00002 * Math.sin((y * Math.PI * 3000) / 180),
    theta = Math.atan2(y, x) - 0.000003 * Math.cos((x * Math.PI * 3000) / 180);
  const gcjLat = z * Math.sin(theta),
    gcjLng = z * Math.cos(theta);
  let latitude = gcjLat,
    longitude = gcjLng;
  for (let i = 0; i < 10; i++) {
    const d = offset(latitude, longitude);
    latitude -= latitude + d.lat - gcjLat;
    longitude -= longitude + d.lng - gcjLng;
  }
  // Canonical WGS84 precision of the existing Place contract (Decimal(9,6)).
  // This precision does not establish official accuracy or a round-trip.
  return {
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
  };
}
function offset(lat: number, lng: number) {
  const x = lng - 105,
    y = lat - 35,
    pi = Math.PI;
  let a =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  a += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  a += ((20 * Math.sin(y * pi) + 40 * Math.sin((y / 3) * pi)) * 2) / 3;
  a +=
    ((160 * Math.sin((y / 12) * pi) + 320 * Math.sin((y * pi) / 30)) * 2) / 3;
  let b =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  b += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  b += ((20 * Math.sin(x * pi) + 40 * Math.sin((x / 3) * pi)) * 2) / 3;
  b +=
    ((150 * Math.sin((x / 12) * pi) + 300 * Math.sin((x / 30) * pi)) * 2) / 3;
  const rad = (lat * pi) / 180,
    magic = 1 - 0.006693421622965943 * Math.sin(rad) ** 2;
  return {
    lat:
      (a * 180) /
      (((6378245 * (1 - 0.006693421622965943)) / (magic * Math.sqrt(magic))) *
        pi),
    lng: (b * 180) / ((6378245 / Math.sqrt(magic)) * Math.cos(rad) * pi),
  };
}
